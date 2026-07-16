export default function GuidePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">このアプリの使い方</h1>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">これは何？</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          精神保健福祉士の国家試験対策のための、練習問題アプリです。教科書や過去問をもとに、
          AIがそのつど新しい練習問題を作ってくれます。市販の問題集と違って、問題の数が
          決まっているわけではなく、使えば使うほど問題のストックが増えていきます。
        </p>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">3つの使い方</h2>
        <div className="mt-3 space-y-4 text-sm leading-relaxed text-stone-700">
          <div>
            <p className="font-medium text-stone-900">① 分野別演習</p>
            <p className="mt-1">
              科目を1つ選んで、1問ずつじっくり解きます。答えるとすぐに正解と解説が表示されるので、
              1問ごとに理解しながら進められます。
            </p>
          </div>
          <div>
            <p className="font-medium text-stone-900">② 全分野ミニ模試</p>
            <p className="mt-1">
              本番の試験に近い形式で、いろいろな科目から3問ずつまとめて出題されます。
              解答と解説はすぐには出ません。最後まで解き終わると、科目ごとの得点率がわかる
              結果レポートが表示されます。
            </p>
          </div>
          <div>
            <p className="font-medium text-stone-900">③ 復習モード</p>
            <p className="mt-1">間違えた問題を優先的にもう一度出題します。苦手の潰し込みに使ってください。</p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">「問題を準備しています」と出たら</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          このアプリはAIがその場で問題を書き上げているため、新しい問題を用意するのに
          20〜40秒ほどかかることがあります。「次の問題を生成中です」と表示されたら、
          少しだけそのままお待ちください。自動的に問題が表示されます。
        </p>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">使い込むほど、問題の出方が変わっていきます</h2>
        <div className="mt-2 space-y-2 text-sm leading-relaxed text-stone-700">
          <p>
            ある科目を使い始めたばかりのころは、出てくる問題はほぼ毎回まったくの新作です。
          </p>
          <p>
            その科目でだいぶ問題が貯まってくると、少しずつ「前に見たことのある問題」が
            混ざるようになります。真新しさより、たくさん練習できることを優先する切り替えです。
          </p>
          <p>
            さらに問題が十分な数まで貯まった科目については、それ以上の新作は作らなくなり、
            すでに貯まった問題の中から出題されるようになります。「もう問題が増えないな」と
            感じたら、その科目はしっかりストックが貯まったということです。
          </p>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">解いている途中でアプリを閉じてしまっても</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          分野別演習やミニ模試の途中でブラウザを閉じたり、リロードしてしまっても大丈夫です。
          次にそのモードを開いたときに「前回の続きから再開しますか？」という案内が出るので、
          そこから続けるか、新しく始めるかを選べます。
        </p>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-warm">
        <h2 className="font-bold text-indigo-700">教科書の根拠について</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-700">
          解説の下に「教科書の根拠」として、実際にその教科書から抜き出した文章が表示されます。
          古い教科書PDFの都合で、まれに文字が読みにくくなっている箇所がありますが、
          問題や解説自体の正しさには影響しません。
        </p>
      </section>
    </div>
  );
}
