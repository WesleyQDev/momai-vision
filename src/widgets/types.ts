export type WidgetSize = 'compact_1x1' | 'compact_2x1' | 'compact_2x2' | 'expanded'
export type WidgetAppearance = 'default' | 'transparent' | 'accent'

export interface WidgetProps<TConfig = Record<string, unknown>> {
  size?: WidgetSize
  appearance?: WidgetAppearance
  isEditing?: boolean
  config?: TConfig
  onUpdateConfig?: (patch: Partial<TConfig>) => void
}
