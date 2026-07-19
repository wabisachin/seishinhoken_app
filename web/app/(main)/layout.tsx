import ProfileGate from "./ProfileGate";
import ProfileBadge from "./ProfileBadge";
import { TitleLink, NavLinks } from "./HeaderNav";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header
        className="sticky top-0 z-10 bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-warm"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="mx-auto max-w-4xl px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <TitleLink />
            <ProfileBadge />
          </div>
          <NavLinks />
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6">
        <ProfileGate>{children}</ProfileGate>
      </main>
    </>
  );
}
