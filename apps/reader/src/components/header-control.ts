/**
 * The controls on the header's right are one family (DESIGN.md): 34px tall and round, on
 * `surface`, in a `line` border that darkens on hover. The search link and the theme menu are
 * circles of it, the Read-in toggle a pill. Each adds its own display and shrink, since a caller
 * may hide it below `sm`, where the controls stay shrinkable.
 */
export const CONTROL = 'h-[34px] rounded-full border border-line bg-surface hover:border-muted'
