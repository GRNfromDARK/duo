export const SETUP_SURFACE_MAX_WIDTH = 70;
export const OVERLAY_SURFACE_MAX_WIDTH = 88;
export const SESSION_CONTENT_MAX_WIDTH = 104;

function clampWidth(
  columns: number,
  maxWidth: number,
  gutter: number,
  minWidth: number,
): number {
  const available = Math.max(minWidth, columns - gutter);
  return Math.max(minWidth, Math.min(maxWidth, available));
}

export function computeSetupSurfaceWidth(columns: number): number {
  return clampWidth(columns, SETUP_SURFACE_MAX_WIDTH, 6, 44);
}

export function computeOverlaySurfaceWidth(columns: number): number {
  return clampWidth(columns, OVERLAY_SURFACE_MAX_WIDTH, 6, 42);
}

export function computeSessionContentWidth(columns: number): number {
  return clampWidth(columns, SESSION_CONTENT_MAX_WIDTH, 6, 48);
}

export function computeSetupDividerWidth(surfaceWidth: number): number {
  return Math.max(20, surfaceWidth - 10);
}
