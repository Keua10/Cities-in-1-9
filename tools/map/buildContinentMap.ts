/**
 * 시작 화면용 대륙 자료를 미리 만든다.
 *
 *   public/maps/continent-v2.bin  청크마다 4바이트 통계 (sites.ts ChunkStatTable)
 *   public/maps/continent-v2.png  1픽셀 = 16칸 미리보기 지도
 *
 * 둘 다 지형 함수에서 결정론적으로 나온다. 학생 태블릿에서 대륙 전체(1만 7천
 * 청크)를 매번 계산하면 수 초가 걸리므로 여기서 한 번 만든다. 지형 코드를
 * 고치면 `npm run map:build` 로 다시 만들고, `npm run check continent` 가
 * 파일이 생성기와 같은지 확인한다.
 */
import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
import { renderOverview } from './continentOverview';
import { ChunkStatTable } from '../../src/world/sites';

const table = ChunkStatTable.compute();
writeFileSync('public/maps/continent-v2.bin', table.raw);
const { width, height, rgba } = renderOverview();
const canvas = createCanvas(width, height);
const ctx = canvas.getContext('2d');
const img = ctx.createImageData(width, height);
img.data.set(rgba);
ctx.putImageData(img, 0, 0);
writeFileSync('public/maps/continent-v2.png', canvas.toBuffer('image/png'));
console.log(`continent map: ${table.raw.length} bytes stats, ${width}x${height} overview`);
