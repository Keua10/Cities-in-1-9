import type { MetroNetwork } from '../sim/metro';
import type { Tools } from './tools';
import './metroPanel.css';

export class MetroPanel {
  private root = document.createElement('section');
  private content = document.createElement('div');
  private stamp = '';
  constructor(
    private metro: MetroNetwork,
    private tools: Tools,
  ) {
    this.root.id = 'metro-panel';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', '지하철 망 정보');
    const header = document.createElement('header');
    const title = document.createElement('b');
    title.textContent = '지하철';
    const close = document.createElement('button');
    close.textContent = '지상으로';
    close.onclick = () => document.getElementById('cancel-build')?.click();
    header.append(title, close);
    this.root.append(header, this.content);
    document.body.append(this.root);
  }
  update(): void {
    this.root.hidden = !this.tools.metroMode;
    if (this.root.hidden) return;
    const stamp = `${this.metro.revision}:${this.tools.metroSelection}:${this.tools.tool}`;
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    this.content.replaceChildren();
    const add = (text: string, className = '') => {
      const p = document.createElement('p');
      p.className = className;
      p.textContent = text;
      this.content.append(p);
    };
    const state = this.metro.state,
      stations = Object.keys(state.stations);
    add(`역 ${stations.length}개 · 터널 ${Object.keys(state.tunnels).length}칸`, 'metro-summary');
    add('청록색: 터널 연결 · 금색 역: 다른 역과 연결 필요');
    const selected = this.tools.metroSelection;
    if (selected && state.stations[selected]) {
      add(state.stations[selected].name, 'metro-summary');
      const peers = this.metro.connectedStations(selected);
      add(
        peers.length
          ? `연결된 역 ${peers.length}개: ${peers.map((k) => state.stations[k].name).join(', ')}`
          : '연결된 다른 역이 없습니다. 터널을 이어 주세요.',
      );
    } else add('역을 누르면 연결 상태를 확인할 수 있습니다.');
    add('노선 미지정 · 열차 운행 없음', 'metro-state');
  }
}
