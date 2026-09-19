import React from 'react'
import { useI18n } from '../hooks/useI18n'

export interface PaginationProps {
  page: number
  pageSize?: number
  totalItems: number
  onPageChange: (page: number) => void
  className?: string
}

export function buildPageWindow(current: number, totalPages: number, maxVisible = 5): number[] {
  if (totalPages <= maxVisible) {
    return Array.from({ length: totalPages }, (_, i) => i + 1)
  }
  const half = Math.floor(maxVisible / 2)
  let start = Math.max(1, current - half)
  let end = Math.min(totalPages, start + maxVisible - 1)
  if (end - start + 1 < maxVisible) {
    start = Math.max(1, end - maxVisible + 1)
  }
  const pages: number[] = []
  for (let p = start; p <= end; p++) {
    pages.push(p)
  }
  return pages
}

export const Pagination: React.FC<PaginationProps> = ({
  page,
  pageSize = 5,
  totalItems,
  onPageChange,
  className = ''
}) => {
  const { t } = useI18n()

  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  if (totalPages <= 1) return null

  const currentPage = Math.min(Math.max(1, page), totalPages)
  const numbers = buildPageWindow(currentPage, totalPages)
  const firstNumber = numbers[0]
  const lastNumber = numbers[numbers.length - 1]
  const isFirst = currentPage <= 1
  const isLast = currentPage >= totalPages

  const from = (currentPage - 1) * pageSize + 1
  const to = Math.min(currentPage * pageSize, totalItems)

  const numberButtonClass = (isActive: boolean) =>
    `min-w-[32px] h-8 px-2 text-xs font-medium rounded-lg transition-all flex items-center justify-center cursor-pointer ${
      isActive
        ? 'bg-primary text-text font-bold shadow-sm'
        : 'text-text-muted hover:text-text hover:bg-input border border-border/30'
    }`

  return (
    <nav
      className={`flex flex-col sm:flex-row items-center justify-between gap-3 pt-4 border-t border-border/20 ${className}`}
      aria-label={t('pagination.pageOf', { page: currentPage, pages: totalPages })}
    >
      <p className="text-xs text-text-muted">
        {t('pagination.showing', { from, to, total: totalItems })}
      </p>

      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={isFirst}
          className="h-8 px-3 text-xs text-text-muted hover:text-text hover:bg-input rounded-lg border border-border/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center gap-1"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>{t('pagination.previous')}</span>
        </button>

        {firstNumber > 1 && (
          <>
            <button
              onClick={() => onPageChange(1)}
              className={numberButtonClass(currentPage === 1)}
            >
              1
            </button>
            {firstNumber > 2 && <span className="px-1 text-xs text-text-muted">…</span>}
          </>
        )}

        {numbers.map((num) => (
          <button
            key={num}
            onClick={() => onPageChange(num)}
            aria-current={num === currentPage ? 'page' : undefined}
            className={numberButtonClass(num === currentPage)}
          >
            {num}
          </button>
        ))}

        {lastNumber < totalPages && (
          <>
            {lastNumber < totalPages - 1 && <span className="px-1 text-xs text-text-muted">…</span>}
            <button
              onClick={() => onPageChange(totalPages)}
              className={numberButtonClass(currentPage === totalPages)}
            >
              {totalPages}
            </button>
          </>
        )}

        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={isLast}
          className="h-8 px-3 text-xs text-text-muted hover:text-text hover:bg-input rounded-lg border border-border/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center gap-1"
        >
          <span>{t('pagination.next')}</span>
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>
    </nav>
  )
}
