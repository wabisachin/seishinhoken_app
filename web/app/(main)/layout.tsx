import Link from "next/link";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="bg-indigo-700 text-white">
        <nav className="mx-auto flex max-w-4xl items-center gap-6 px-4 py-3">
          <Link href="/" className="text-lg font-bold">
            精神保健福祉士 試験対策
          </Link>
          <div className="flex gap-4 text-sm">
            <Link href="/quiz" className="hover:underline">演習</Link>
            <Link href="/stats" className="hover:underline">成績</Link>
          </div>
        </nav>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6">{children}</main>
    </>
  );
}
