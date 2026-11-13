// Canvas 2D helpers shared by thumbnails and the fallback compositor.

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Draw `image` (stored size sw x sh) filling a dw x dh box, applying clockwise rotation metadata. */
export function drawRotated(ctx: Ctx, image: CanvasImageSource, sw: number, sh: number, rotation: number, dw: number, dh: number): void {
  ctx.save();
  ctx.translate(dw / 2, dh / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  const swap = rotation === 90 || rotation === 270;
  const w = swap ? dh : dw;
  const h = swap ? dw : dh;
  ctx.drawImage(image, 0, 0, sw, sh, -w / 2, -h / 2, w, h);
  ctx.restore();
}
