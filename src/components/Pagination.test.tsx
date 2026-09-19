import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Pagination, buildPageWindow } from './Pagination'

describe('Pagination & buildPageWindow', () => {
  it('calculates page window correctly when totalPages <= maxVisible', () => {
    expect(buildPageWindow(1, 3)).toEqual([1, 2, 3])
    expect(buildPageWindow(2, 5)).toEqual([1, 2, 3, 4, 5])
  })

  it('calculates sliding page window for large totalPages', () => {
    expect(buildPageWindow(1, 10, 5)).toEqual([1, 2, 3, 4, 5])
    expect(buildPageWindow(5, 10, 5)).toEqual([3, 4, 5, 6, 7])
    expect(buildPageWindow(10, 10, 5)).toEqual([6, 7, 8, 9, 10])
  })

  it('does not render pagination when totalItems <= pageSize', () => {
    const onPageChange = vi.fn()
    const { container } = render(
      <Pagination page={1} pageSize={5} totalItems={5} onPageChange={onPageChange} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders pagination and handles page click when items > 5', () => {
    const onPageChange = vi.fn()
    render(
      <Pagination page={1} pageSize={5} totalItems={12} onPageChange={onPageChange} />
    )

    // Total pages = ceil(12/5) = 3
    expect(screen.getByText(/1.*5.*12/)).toBeTruthy()
    const page2Button = screen.getByRole('button', { name: '2' })
    fireEvent.click(page2Button)
    expect(onPageChange).toHaveBeenCalledWith(2)

    const nextButton = screen.getByRole('button', { name: /Próximo|Next/i })
    fireEvent.click(nextButton)
    expect(onPageChange).toHaveBeenCalledWith(2)
  })
})
