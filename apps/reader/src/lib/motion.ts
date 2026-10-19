/**
 * How a scroll the script makes moves: smoothly, or at once for a reader who asks for less motion
 * (the stylesheet turns the fade and the skeletons' pulse off for them; a scroll is the script's).
 */
export function scrollMotion(): ScrollBehavior {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}
