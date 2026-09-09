/**
 * Placeholders for the reading panes while their queries are in flight.
 *
 * They exist so the header and the page frame reach the browser before the database has
 * answered. On a client navigation React keeps the panes that are already on screen instead of
 * showing these, so clicking an article does not blank the list.
 */

function Line({ w, h = 12 }: { w: string; h?: number }) {
  return <div className="rounded bg-hover" style={{ width: w, height: h }} />
}

export function ListPanesSkeleton() {
  return (
    <>
      <aside
        aria-hidden
        className="hidden flex-col gap-6 border-r border-line px-3.5 py-5 lg:sticky lg:top-14 lg:flex lg:h-[calc(100vh-56px)]"
      >
        <div className="flex flex-col gap-3">
          {['92px', '76px', '68px'].map((w) => (
            <Line key={w} w={w} />
          ))}
        </div>
        <div className="flex flex-col gap-3 pt-4">
          {['120px', '104px', '132px', '88px'].map((w) => (
            <Line key={w} w={w} />
          ))}
        </div>
      </aside>
      <div
        aria-hidden
        className="flex flex-col gap-6 px-3 py-5 group-data-[open=1]:hidden lg:group-data-[open=1]:flex"
      >
        {['a', 'b', 'c', 'd', 'e', 'f'].map((row) => (
          <div key={row} className="flex flex-col gap-2 border-t border-line pt-3.5">
            <Line w="40%" h={10} />
            <Line w="85%" h={16} />
            <Line w="70%" h={12} />
          </div>
        ))}
      </div>
    </>
  )
}

export function ReaderPaneSkeleton() {
  return (
    <main aria-hidden className="min-w-0 px-5 pb-20 pt-6 md:px-8">
      <div className="mx-auto flex max-w-[1240px] flex-col gap-4">
        <Line w="180px" h={12} />
        <Line w="70%" h={30} />
        <div className="flex flex-col gap-3 pt-6">
          {['100%', '96%', '92%', '98%', '80%', '94%', '87%'].map((w) => (
            <Line key={w} w={w} h={14} />
          ))}
        </div>
      </div>
    </main>
  )
}
