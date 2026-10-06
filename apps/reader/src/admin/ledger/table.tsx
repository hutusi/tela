/**
 * The ledger's table as assistive technology reads it: a table of rows and cells, with the sorted
 * column's direction in `aria-sort`. The rows are laid out by CSS grid, whose columns change with
 * the breakpoint and the open record, which a `<table>` cannot take; so the roles say what the
 * markup cannot, here and nowhere else. Rows and headers are not Tab stops: a row's name is a link,
 * and the console's keys move between rows.
 */
import type { ComponentProps } from 'react'

export function Table(props: ComponentProps<'div'>) {
  // biome-ignore lint/a11y/useSemanticElements: a grid-laid table, which a <table> cannot be
  return <div role="table" {...props} />
}

export function Row(props: ComponentProps<'div'>) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a grid-laid row, which a <tr> cannot be
    // biome-ignore lint/a11y/useFocusableInteractive: reached by its name's link and the console's keys
    <div role="row" {...props} />
  )
}

export function Cell(props: ComponentProps<'div'>) {
  // biome-ignore lint/a11y/useSemanticElements: a grid-laid cell, which a <td> cannot be
  return <div role="cell" {...props} />
}

/** A column's header; `sort` is its direction while the ledger is sorted by it. */
export function HeaderCell({
  sort = null,
  ...props
}: ComponentProps<'div'> & { sort?: 'asc' | 'desc' | null }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a grid-laid header, which a <th> cannot be
    // biome-ignore lint/a11y/useFocusableInteractive: its sort button is the Tab stop
    <div
      role="columnheader"
      aria-sort={sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : undefined}
      {...props}
    />
  )
}
