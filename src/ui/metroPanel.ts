import { METRO_COLORS, type MetroNetwork, type MetroLine } from '../sim/metro';
import type { Tools } from './tools';
import './metroPanel.css';

export class MetroPanel {
  private root = document.createElement('section');
  private content = document.createElement('div');
  private stamp = '';
  private draft: { id: string | null; name: string; color: string; stops: string[] } | null = null;
  private message = '';
  constructor(
    private metro: MetroNetwork,
    private tools: Tools,
  ) {
    this.root.id = 'metro-panel';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', '지하철 망 정보');
    const header = document.createElement('header'),
      title = document.createElement('b'),
      close = document.createElement('button');
    title.textContent = '지하철';
    close.textContent = '지상으로';
    close.onclick = () => {
      this.draft = null;
      this.stamp = '';
      document.getElementById('cancel-build')?.click();
    };
    header.append(title, close);
    this.root.append(header, this.content);
    document.body.append(this.root);
  }
  selectStation(key: string): void {
    this.tools.metroSelection = key;
    if (this.draft && this.metro.state.stations[key]) {
      if (this.draft.stops.includes(key)) this.message = '이미 정차역에 포함되어 있습니다.';
      else if (this.draft.stops.length >= 32) this.message = '정차역은 최대 32개입니다.';
      else {
        this.draft.stops.push(key);
        this.message = '';
      }
      this.stamp = '';
    }
  }
  private edit(line?: MetroLine): void {
    this.draft = line
      ? { ...line, stops: [...line.stops] }
      : {
          id: null,
          name: '새 노선',
          color: METRO_COLORS[(this.metro.state.lines?.length ?? 0) % METRO_COLORS.length],
          stops: [],
        };
    this.tools.setTool('metroView');
    this.message = '지도에서 정차역을 순서대로 누르세요.';
    this.stamp = '';
  }
  update(): void {
    this.root.hidden = !this.tools.metroMode;
    if (this.root.hidden) return;
    const stamp = [
      this.metro.revision,
      this.metro.surfaceRevision,
      this.tools.metroSelection,
      this.tools.tool,
    ].join(':');
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    this.content.replaceChildren();
    const add = (text: string, cls = '') => {
      const p = document.createElement('p');
      p.textContent = text;
      p.className = cls;
      this.content.append(p);
      return p;
    };
    const button = (label: string, fn: () => void, parent: HTMLElement = this.content) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => {
        fn();
        this.stamp = '';
        this.update();
      };
      parent.append(b);
      return b;
    };
    const state = this.metro.state;
    add(
      '역 ' +
        Object.keys(state.stations).length +
        '개 · 터널 ' +
        Object.keys(state.tunnels).length +
        '칸',
      'metro-summary',
    );
    if (this.draft) {
      const draft = this.draft;
      const label = document.createElement('label');
      label.textContent = '노선 이름';
      const name = document.createElement('input');
      name.value = draft.name;
      name.maxLength = 24;
      name.setAttribute('aria-label', '노선 이름');
      name.oninput = () => {
        draft.name = name.value;
      };
      label.append(name);
      this.content.append(label);
      const colors = document.createElement('div');
      colors.className = 'metro-colors';
      METRO_COLORS.forEach((color, i) => {
        const b = button(
          '●',
          () => {
            draft.color = color;
          },
          colors,
        );
        b.style.color = color;
        b.setAttribute('aria-label', '노선 색상 ' + (i + 1));
        b.setAttribute('aria-pressed', String(color === draft.color));
      });
      this.content.append(colors);
      add('지도에서 역을 누르면 정차 순서에 추가됩니다.');
      draft.stops.forEach((key, i) => {
        const row = document.createElement('div');
        row.className = 'metro-stop';
        const text = document.createElement('span');
        text.textContent = i + 1 + '. ' + (state.stations[key]?.name ?? '철거된 역');
        row.append(text);
        const up = button(
          '↑',
          () => {
            [draft.stops[i - 1], draft.stops[i]] = [draft.stops[i], draft.stops[i - 1]];
          },
          row,
        );
        up.disabled = i === 0;
        up.setAttribute('aria-label', text.textContent + ' 앞으로');
        const down = button(
          '↓',
          () => {
            [draft.stops[i + 1], draft.stops[i]] = [draft.stops[i], draft.stops[i + 1]];
          },
          row,
        );
        down.disabled = i === draft.stops.length - 1;
        down.setAttribute('aria-label', text.textContent + ' 뒤로');
        button(
          '빼기',
          () => {
            draft.stops.splice(i, 1);
          },
          row,
        );
        this.content.append(row);
      });
      button('노선 저장', () => {
        const r = this.metro.saveLine(draft.id, draft.name, draft.color, draft.stops);
        this.message = r.message;
        if (r.ok) this.draft = null;
      });
      button('편집 취소', () => {
        this.draft = null;
        this.message = '';
      });
    } else {
      const selected = this.tools.metroSelection;
      if (selected && state.stations[selected]) {
        add(state.stations[selected].name, 'metro-summary');
        const access = this.metro.stationAccess(selected);
        add(access ? '지상 역 · 도로 연결됨' : '출입 불가: 지상 역 또는 진입 도로가 없습니다.');
        if (!access)
          button('지상 역 복구', () => {
            this.message = this.metro.repairSurface(selected).message;
          });
        const peers = this.metro.connectedStations(selected);
        add(
          peers.length
            ? '터널 연결: ' + peers.map((k) => state.stations[k].name).join(', ')
            : '연결된 다른 역이 없습니다.',
        );
      }
      button('새 노선', () => this.edit());
      for (const line of state.lines ?? []) {
        const row = add(line.name + ' · ' + line.stops.length + '개 역', 'metro-summary');
        row.style.borderLeft = '4px solid ' + line.color;
        row.style.paddingLeft = '8px';
        const valid =
          !!this.metro.linePath(line.stops) && line.stops.every((k) => this.metro.stationAccess(k));
        add(valid ? '연결 정상 · 운행 준비' : '연결 끊김 / 역 출입 불가');
        button(line.name + ' 편집', () => this.edit(line));
        button(line.name + ' 삭제', () => {
          this.metro.deleteLine(line.id);
          this.message = '노선만 삭제했습니다. 역과 터널은 유지됩니다.';
        });
      }
    }
    if (this.message) add(this.message, 'metro-message');
    add('열차·승객 운행은 다음 단계에 추가됩니다.', 'metro-state');
  }
}
