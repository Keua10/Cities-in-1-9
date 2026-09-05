// 노드 검증용 pixi 스텁. 실제 빌드에는 들어가지 않는다.
export class Texture { static from(_: unknown): Texture { return new Texture(); } source = { scaleMode: '', autoGenerateMipmaps: false }; }
export class Mesh {}
export class MeshGeometry {}
export class Container {}
export class Graphics {}
