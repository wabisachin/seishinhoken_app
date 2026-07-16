import Link from "next/link";
import ProfileGate from "./ProfileGate";
import ProfileBadge from "./ProfileBadge";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header
        className="sticky top-0 z-10 bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-warm"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <nav className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/" className="text-base font-bold leading-tight tracking-wide sm:text-lg">
            精神保健福祉士 試験対策
          </Link>
          <div className="flex items-center gap-5 text-sm font-medium text-indigo-50">
            <Link href="/quiz" className="transition-colors hover:text-white">演習</Link>
            <Link href="/full-mock" className="transition-colors hover:text-white">本番模試</Link>
            <Link href="/stats" className="transition-colors hover:text-white">成績</Link>
            <Link href="/guide" className="transition-colors hover:text-white">使い方</Link>
            <ProfileBadge />
          </div>
        </nav>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6">
        <ProfileGate>{children}</ProfileGate>
      </main>
    </>
  );
}
