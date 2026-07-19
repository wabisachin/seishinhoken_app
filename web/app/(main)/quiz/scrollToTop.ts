// 次のセット/問題に進む・解答結果を表示する際に呼ぶ。ページ下部までスクロールした
// 状態のまま新しい内容に切り替わると、内容が変わったのに読み始め位置が前のままで
// 読みにくいため、切り替えの瞬間に先頭へ戻す。
export function scrollToTop() {
  if (typeof window === "undefined") return;
  window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
}
