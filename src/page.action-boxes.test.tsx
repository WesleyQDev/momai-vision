import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ActionEditor } from './page'

beforeEach(() => {
  cleanup()
})

describe('ActionEditor — Enviar com boxes por ação (MOM-171)', () => {
  it('liga includeBoxes e troca a imagem limpa pela anotada', async () => {
    const onChange = vi.fn()
    const actions = [{ id: 'a1', target: 'whatsapp', tool: 'send_message', args: { contact: 'Ana' } }]
    render(<ActionEditor actions={actions} onChange={onChange} />)

    const toggle = (await screen.findByRole('checkbox', { name: 'Enviar com boxes' })) as HTMLInputElement
    expect(toggle.checked).toBe(false)

    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toEqual([
      { id: 'a1', target: 'whatsapp', tool: 'send_message', args: { contact: 'Ana', includeBoxes: true, image: '{event.annotatedImageDataUri}' } }
    ])
  })

  it('mostra ligado quando a ação já tem includeBoxes e desliga removendo a chave', async () => {
    const onChange = vi.fn()
    const actions = [{ id: 'a1', target: 'whatsapp', tool: 'send_message', args: { contact: 'Ana', includeBoxes: true } }]
    render(<ActionEditor actions={actions} onChange={onChange} />)

    const toggle = (await screen.findByRole('checkbox', { name: 'Enviar com boxes' })) as HTMLInputElement
    expect(toggle.checked).toBe(true)

    fireEvent.click(toggle)
    expect(onChange.mock.calls[0][0]).toEqual([
      { id: 'a1', target: 'whatsapp', tool: 'send_message', args: { contact: 'Ana' } }
    ])
  })
})
