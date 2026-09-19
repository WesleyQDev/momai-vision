import type { JSX } from 'react'

interface Props {
  title: string
  message: string
}

export function WidgetState({ title, message }: Props): JSX.Element {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-1 p-4 text-center">
      <span className="text-xs font-semibold text-text">{title}</span>
      <span className="text-[11px] text-text-muted">{message}</span>
    </div>
  )
}

export function WidgetLoading({ message }: { message: string }): JSX.Element {
  return (
    <div className="w-full h-full flex items-center justify-center p-4 text-text-muted">
      <span className="text-xs">{message}</span>
    </div>
  )
}
