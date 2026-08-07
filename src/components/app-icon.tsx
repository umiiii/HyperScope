type AppIconProps = {
  size: number;
};

export function AppIcon({ size }: AppIconProps) {
  const border = Math.max(6, Math.round(size * 0.045));
  const outer = Math.round(size * 0.62);
  const middle = Math.round(size * 0.38);
  const dot = Math.round(size * 0.14);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#111714",
      }}
    >
      <div
        style={{
          width: outer,
          height: outer,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: `${border}px solid #f3f1e9`,
          borderRadius: "999px",
        }}
      >
        <div
          style={{
            width: middle,
            height: middle,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: `${Math.max(4, Math.round(border * 0.65))}px solid #f1522d`,
            borderRadius: "999px",
          }}
        >
          <div
            style={{
              width: dot,
              height: dot,
              background: "#f1522d",
              borderRadius: "999px",
            }}
          />
        </div>
      </div>
    </div>
  );
}
