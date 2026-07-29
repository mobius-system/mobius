type MobiusLogoProps = {
  size?: number
  className?: string
}

export function MobiusLogo({ size = 25, className = '' }: MobiusLogoProps) {
  const width = Math.round(size * 1.62)

  return (
    <span
      className={`mobius-brand-logo ${className}`}
      style={{ width, height: size }}
      aria-hidden="true"
      role="presentation">
      <img
        src="/logo.png"
        alt=""
        className="mobius-brand-logo__image"
        draggable={false}
      />
    </span>
  )
}
