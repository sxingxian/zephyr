/** Small activity indicator. Decorative unless given a label. */
export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return label ? (
    <span className="z-spinner" style={{ width: size, height: size }} role="status" aria-label={label} />
  ) : (
    <span className="z-spinner" style={{ width: size, height: size }} aria-hidden="true" />
  );
}
