import Link from "next/link";

export default function FullMockPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">完全本番型模試</h1>
        <span className="mt-1 inline-block rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
          準備中（近日公開予定）
        </span>
      </div>

      <section className="rounded-2xl border-l-4 border-violet-400 bg-white p-5 shadow-warm">
        <h2 className="font-bold text-violet-700">これから追加される機能です</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          今の「全分野ミニ模試」は3問ずつ気軽に力試しするモードですが、「完全本番型模試」は
          本番の国家試験そのものを再現する、より本格的なモードとして用意する予定です。
        </p>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">実装予定の内容</h2>
        <ul className="mt-3 space-y-3 text-sm leading-relaxed text-stone-700">
          <li className="flex gap-2">
            <span className="text-indigo-400">・</span>
            <span>
              <span className="font-medium text-stone-900">本番と同じ出題形式・科目配分</span>
              ―― 午前（共通科目）・午後（専門科目）の2部制を再現し、科目ごとの出題数の
              バランスも実際の試験に合わせます。
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-indigo-400">・</span>
            <span>
              <span className="font-medium text-stone-900">制限時間つきのタイマー</span>
              ―― 本番同様、時間内に解き切る感覚を練習できるようにします。
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-indigo-400">・</span>
            <span>
              <span className="font-medium text-stone-900">すべて新規に生成するオリジナル問題</span>
              ―― 分野別演習やミニ模試のように貯まった問題を再利用するのではなく、
              受験するたびにその場で新しく作られた、一度も見たことのない問題だけで構成します。
            </span>
          </li>
        </ul>
        <p className="mt-4 text-xs text-stone-400">
          ※ 内容は開発が進むにつれて変わる可能性があります。
        </p>
      </section>

      <Link
        href="/quiz?mode=mock"
        className="inline-flex min-h-12 items-center rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white transition-colors hover:bg-indigo-700"
      >
        今すぐ全分野ミニ模試を試す
      </Link>
    </div>
  );
}
