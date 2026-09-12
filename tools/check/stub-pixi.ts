// 노드 검증용 pixi 스텁. 실제 빌드에는 들어가지 않는다.
export class Texture {
  static from(resource: unknown): Texture {
    const texture = new Texture();
    texture.source.resource = resource;
    return texture;
  }
  source = { scaleMode: '', autoGenerateMipmaps: false, resource: undefined as unknown };
}
export class Mesh {
  constructor(options: unknown) {
    Object.assign(this, options);
  }
  destroy() {}
}
export class MeshGeometry {
  constructor(options: unknown) {
    Object.assign(this, options);
  }
  destroy() {}
  getBuffer() {
    return { update() {} };
  }
}
export class Container {}
export class Graphics {}
