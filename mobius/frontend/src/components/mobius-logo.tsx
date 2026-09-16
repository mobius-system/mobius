import { useCustomLogo } from '../services/brand-overrides'

type MobiusLogoProps = {
  size?: number
  className?: string
}

export function MobiusLogo({ size = 32, className = '' }: MobiusLogoProps) {
  // 用户在「其他设置」里上传的自定义 logo 优先; 只存在当前浏览器, 未上传时用内置图片。
  const customLogo = useCustomLogo()
  const width = Math.round(size * 1.0)

  return (
    <span
      className={`mobius-brand-logo ${className}`}
      style={{ width, height: size }}
      aria-hidden="true"
      role="presentation">
      <img
        src={customLogo || '/logo.png'}
        alt=""
        className="mobius-brand-logo__image"
        draggable={false}
      />
    </span>
  )
}
