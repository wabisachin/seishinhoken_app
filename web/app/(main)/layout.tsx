import Link from "next/link";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="sticky top-0 z-10 bg-indigo-700 text-white shadow-sm" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <nav className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/" className="text-base font-bold leading-tight sm:text-lg">
            精神保健福祉士 試験対策
          </Link>
          <div className="flex gap-5 text-sm">
            <Link href="/quiz" className="hover:underline">演習</Link>
            <Link href="/stats" className="hover:underline">成績</Link>
            <Link href="/guide" className="hover:underline">使い方</Link>
          </div>
        </nav>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6">{children}</main>
    </>
  );
}
