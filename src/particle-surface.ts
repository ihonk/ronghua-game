import {
  CustomBlending, Float32BufferAttribute, HalfFloatType, InstancedBufferAttribute,
  InstancedBufferGeometry, LinearFilter, Mesh, OneFactor,
  OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, Vector2, Vector3,
  WebGLRenderer, WebGLRenderTarget,
} from 'three'
import type { Tile } from './material-surface.ts'

// Four color densities share one RGBA render target. Accumulation and composition
// stay on the GPU, avoiding CPU pixel loops and a full texture upload per frame.
export class ParticleSurface {
  readonly material: ShaderMaterial
  private readonly scene = new Scene()
  private readonly composeScene = new Scene()
  private readonly compose: ShaderMaterial
  private readonly composeQuad = new PlaneGeometry(2, 2)
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, .1, 10)
  private readonly geometry = new InstancedBufferGeometry()
  private readonly centers: InstancedBufferAttribute
  private readonly radii: InstancedBufferAttribute
  private readonly inks: InstancedBufferAttribute
  private readonly splat: ShaderMaterial
  private readonly target = new WebGLRenderTarget(1, 1, {
    type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter,
    depthBuffer: false, stencilBuffer: false,
  })
  private readonly output = new WebGLRenderTarget(1, 1, {
    minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false, stencilBuffer: false,
  })
  private readonly indices = new Map<string, number>()
  private height = 1

  constructor(colors: string[], capacity: number) {
    if (colors.length !== 4) throw new Error('GPU 材料表面需要四种颜色')
    this.geometry.setAttribute('position', new Float32BufferAttribute([
      -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0,
    ], 3))
    this.centers = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2)
    this.radii = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2)
    this.inks = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    this.geometry.setAttribute('center', this.centers)
    this.geometry.setAttribute('radius', this.radii)
    this.geometry.setAttribute('ink', this.inks)
    this.splat = new ShaderMaterial({
      uniforms: { resolution: { value: new Vector2(1, 1) } },
      vertexShader: `
        attribute vec2 center;
        attribute vec2 radius;
        attribute vec4 ink;
        uniform vec2 resolution;
        varying vec2 kernelPosition;
        varying vec4 densityColor;
        void main() {
          kernelPosition = position.xy;
          densityColor = ink;
          vec2 pixel = center + position.xy * radius;
          gl_Position = vec4(pixel / resolution * 2.0 - 1.0, 0.0, 1.0);
        }`,
      fragmentShader: `
        varying vec2 kernelPosition;
        varying vec4 densityColor;
        void main() {
          float kernel = max(0.0, 1.0 - dot(kernelPosition, kernelPosition));
          gl_FragColor = densityColor * kernel * kernel;
        }`,
      blending: CustomBlending, blendSrc: OneFactor, blendDst: OneFactor,
      depthTest: false, depthWrite: false,
    })
    const mesh = new Mesh(this.geometry, this.splat)
    mesh.frustumCulled = false
    this.scene.add(mesh)
    const palette = colors.map((hex, index) => {
      this.indices.set(hex, index)
      const rgb = parseInt(hex.slice(1), 16)
      return new Vector3((rgb >> 16) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255)
    })
    const inkWeights = palette.map(rgb => 1 + .19 * Math.max(0, Math.min(1,
      (160 - 255 * (.21 * rgb.x + .72 * rgb.y + .07 * rgb.z)) / 100)))
    this.compose = new ShaderMaterial({
      uniforms: {
        densityMap: { value: this.target.texture }, texel: { value: new Vector2(1, 1) },
        palette: { value: palette }, inkWeights: { value: inkWeights },
      },
      vertexShader: `
        varying vec2 densityUv;
        void main() {
          densityUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D densityMap;
        uniform vec2 texel;
        uniform vec3 palette[4];
        uniform float inkWeights[4];
        varying vec2 densityUv;
        void main() {
          vec4 density = texture2D(densityMap, densityUv);
          float total = dot(density, vec4(1.0));
          float alpha = clamp((total - .49) / .30, 0.0, 1.0);
          if (alpha <= 0.0) discard;
          float first = 0.0;
          float second = 0.0;
          vec3 mainColor = palette[0];
          vec3 otherColor = palette[0];
          for (int i = 0; i < 4; i++) {
            float value = density[i] * inkWeights[i];
            if (value > first) {
              second = first;
              otherColor = mainColor;
              first = value;
              mainColor = palette[i];
            } else if (value > second) {
              second = value;
              otherColor = palette[i];
            }
          }
          float blend = second > 0.0 ? clamp(.5 - (first - second) / (.28 * (first + second)), 0.0, 1.0) : 0.0;
          float above = dot(texture2D(densityMap, densityUv + vec2(0.0, texel.y)), vec4(1.0));
          float shine = total < 1.1 ? clamp((total - above) * .30, 0.0, .16) : 0.0;
          float seam = second > .05 ? max(0.0, 1.0 - (first - second) / .14) * .07 : 0.0;
          vec3 color = mix(mainColor, otherColor, blend);
          gl_FragColor = vec4(color + (vec3(1.0) - color) * shine - color * seam, alpha);
        }`,
      depthWrite: false, depthTest: false,
    })
    const composeMesh = new Mesh(this.composeQuad, this.compose)
    composeMesh.position.z = -1
    composeMesh.frustumCulled = false
    this.composeScene.add(composeMesh)
    this.material = new ShaderMaterial({
      uniforms: { surfaceMap: { value: this.output.texture } },
      vertexShader: `
        varying vec2 surfaceUv;
        void main() {
          surfaceUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D surfaceMap;
        varying vec2 surfaceUv;
        void main() { gl_FragColor = texture2D(surfaceMap, surfaceUv); }`,
      transparent: true, depthWrite: false,
    })
  }

  resize(width: number, height: number, textureWidth: number, textureHeight: number) {
    this.height = height
    this.splat.uniforms.resolution.value.set(width, height)
    this.target.setSize(textureWidth, textureHeight)
    this.output.setSize(textureWidth, textureHeight)
    this.compose.uniforms.texel.value.set(1 / textureWidth, 1 / textureHeight)
  }

  paint(renderer: WebGLRenderer, tiles: Tile[]) {
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]
      this.centers.setXY(i, tile.x + tile.w / 2, this.height - tile.y - tile.h / 2)
      this.radii.setXY(i, tile.w * 1.56, tile.h * 1.56)
      const color = this.indices.get(tile.color)!
      this.inks.setXYZW(i, +(color === 0), +(color === 1), +(color === 2), +(color === 3))
    }
    this.geometry.instanceCount = tiles.length
    this.centers.needsUpdate = true
    this.radii.needsUpdate = true
    this.inks.needsUpdate = true
    const previous = renderer.getRenderTarget()
    const alpha = renderer.getClearAlpha()
    renderer.setRenderTarget(this.target)
    renderer.setClearAlpha(0)
    renderer.clear()
    renderer.render(this.scene, this.camera)
    renderer.setRenderTarget(this.output)
    renderer.clear()
    renderer.render(this.composeScene, this.camera)
    renderer.setRenderTarget(previous)
    renderer.setClearAlpha(alpha)
  }

  dispose() {
    this.geometry.dispose()
    this.splat.dispose()
    this.material.dispose()
    this.compose.dispose()
    this.composeQuad.dispose()
    this.output.dispose()
    this.target.dispose()
  }
}
