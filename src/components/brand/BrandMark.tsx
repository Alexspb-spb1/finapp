interface Props {
  className?: string
}

export default function BrandMark({ className }: Props) {
  return <img src={`${import.meta.env.BASE_URL}aktivmetr-mark.svg`} alt="" aria-hidden="true" className={className} />
}
