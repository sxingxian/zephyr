const BGS = ['#F3C6C8', '#C8DAF6', '#CFE5D6', '#E6E1F3', '#F6DDB8'];
const INK = ['#7A3940', '#2B4677', '#2E5A40', '#4A3D78', '#6B4A17'];

/** Initials avatar with a stable colour per person. */
export function Avatar({ text, seed, size = 32 }: { text: string; seed: string; size?: number }) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const i = h % BGS.length;
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
        background: BGS[i],
        color: INK[i],
      }}
    >
      {text}
    </span>
  );
}
