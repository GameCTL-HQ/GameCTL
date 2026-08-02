// src/components/Brand.jsx
export default function Brand({ size = 28 }) {
    return (
      <div className="flex items-center gap-2">
        <img
          src="/brand/gamectl-logo.png"
          alt="GameCTL"
          style={{ height: size, width: 'auto' }}
        />
        <span className="font-semibold">GameCTL</span>
      </div>
    );
  }