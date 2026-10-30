import QRCode from 'qrcode';
import { verifyFragment } from './verify.mjs';

const $ = (id) => document.getElementById(id);
let japanese = navigator.language.startsWith('ja');
let current;
let expiryTimer;
const words = {
  en: {
    title: 'Ask this reviewer’s AI to review your code.', eyebrow: 'A private introduction',
    intro: 'Verify the reviewer, then send your code diff when you are ready.',
    privacy: 'Verified on this device. Your invitation stays in the URL fragment; it is never sent to this site’s server.',
    checking: 'Checking the invitation…', missing: 'No invitation found. Ask the sender for the complete link, including the part after #.',
    invalid: 'This invitation could not be verified. Do not accept it. Ask the sender for a new link through a trusted channel.',
    expired: 'This invitation has expired. Ask the sender for a fresh invitation.',
    valid: 'Signature verified · invitation is current',
    trust: 'A valid signature proves control of these keys, not the person’s real-world identity. Confirm the sender through a channel you trust. Revocation and worker availability are checked when you connect, not on this offline page.',
    ownerLabel: 'Owner identity', agentLabel: 'Agent identity', relayLabel: 'Relay', expiryLabel: 'Valid until',
    installTitle: '01 / Install Sealbridge', installText: 'Install Sealbridge with one line in your terminal. Use the command for your system, then open a new terminal before continuing.',
    acceptTitle: '02 / Ask this reviewer for a review', acceptText: 'In your project folder, save the changes you want reviewed as code.diff (git diff > code.diff). Check the file and remove secrets before sending it. Create your requester identity once with the command below; reuse requester.private.json if it already exists. Keep that key file private. The delegate command rechecks this invitation and sends the diff encrypted to this reviewer through the relay. The reviewer must approve the request.',
    copyLink: 'Copy invitation link',
    nextTitle: '03 / Read and approve the review', nextText: 'Keep both terminals open. When the review arrives, read the result in your terminal and answer y only if you accept it. After approval, review.json contains the result. Opening this page does not send your diff or approve work.',
    copy: 'Copy command', copied: 'Copied', copyFailed: 'Clipboard unavailable. Select and copy the command manually.',
    qrTitle: 'Open on another device', qrText: 'This QR contains the same full invitation link. Share only with the intended recipient.',
    qrLarge: 'This invitation is too large for a QR code. Copy the complete link from your address bar; nothing has been shortened or uploaded.',
    guide: 'Read the getting-started guide', language: '日本語',
  },
  ja: {
    title: 'この相手の AI にコードレビューを依頼できます。', eyebrow: 'プライベートな紹介',
    intro: 'まずレビュー相手を確認し、準備ができたら差分を送ります。',
    privacy: 'この端末で検証します。招待は URL の # 以降だけに保持され、このサイトのサーバーには送信されません。',
    checking: '招待を検証しています…', missing: '招待が見つかりません。# 以降を含む完全なリンクを送信者に確認してください。',
    invalid: '招待を検証できませんでした。受け入れず、信頼できる経路で新しいリンクを依頼してください。',
    expired: 'この招待は期限切れです。送信者に新しい招待を依頼してください。',
    valid: '署名を検証済み・招待は有効です',
    trust: '署名は鍵の管理者を証明しますが、実社会の本人確認ではありません。信頼できる別の経路で相手を確認してください。失効とワーカーの稼働状況は、このオフラインページではなく接続時に確認します。',
    ownerLabel: '所有者の識別子', agentLabel: 'エージェントの識別子', relayLabel: '中継器', expiryLabel: '有効期限',
    installTitle: '01 / Sealbridge をインストール', installText: 'お使いの OS に合う 1 行をターミナルで実行し、Sealbridge をインストールします。完了後、新しいターミナルを開いて次へ進みます。',
    acceptTitle: '02 / この相手にレビューを依頼', acceptText: 'プロジェクトのフォルダーで、レビューしたい差分を code.diff に保存します（git diff > code.diff）。送る前に内容を確認し、秘密情報を除いてください。下のコマンドで依頼者の鍵を初回だけ作成します。requester.private.json があれば再利用し、非公開で保管してください。delegate は招待を再検証し、この相手に差分を暗号化して中継器経由で送ります。相手の承認後にレビューが始まります。',
    copyLink: '招待リンクをコピー',
    nextTitle: '03 / レビューを読んで承認', nextText: '両者ともターミナルを開いたまま待ちます。結果が表示されたら内容を読み、受け入れる場合だけ y を入力してください。承認後、結果は review.json に保存されます。このページを開くだけでは差分の送信や仕事の承認は行いません。',
    copy: 'コマンドをコピー', copied: 'コピーしました', copyFailed: 'クリップボードを利用できません。コマンドを選択して手動でコピーしてください。',
    qrTitle: '別の端末で開く', qrText: 'QR には同じ完全な招待リンクが含まれます。意図した相手だけに共有してください。',
    qrLarge: '招待が大きすぎるため QR を作成できません。アドレスバーから完全なリンクをコピーしてください。短縮やアップロードはしていません。',
    guide: '使い方のガイドを読む', language: 'English',
  },
};

function render() {
  clearTimeout(expiryTimer);
  current = undefined;
  const w = words[japanese ? 'ja' : 'en'];
  document.documentElement.lang = japanese ? 'ja' : 'en';
  for (const element of document.querySelectorAll('[data-text]')) element.textContent = w[element.dataset.text];
  $('guide').href = `https://sealbridge.dev/${japanese ? 'ja' : 'en'}/docs/docs/ux2/`;
  $('verified').hidden = true;
  $('qr').replaceChildren();
  $('command').textContent = '';
  $('copy-status').textContent = '';
  $('status').className = 'notice';
  if (!location.hash) { $('status').textContent = w.missing; return; }
  try {
    current = verifyFragment(location.hash);
    const { invite, command, link } = current;
    $('status').textContent = w.valid;
    $('status').className = 'notice success';
    $('name').textContent = invite.agentCard.payload.name;
    $('owner').textContent = invite.ownerDid;
    $('agent').textContent = invite.agentDid;
    $('relay').textContent = invite.relayUrl;
    const expiry = Math.min(Date.parse(invite.expiresAt), Date.parse(invite.agentCard.payload.expiresAt));
    $('expiry').textContent = new Intl.DateTimeFormat(japanese ? 'ja' : 'en', { dateStyle: 'full', timeStyle: 'long' }).format(expiry);
    $('command').textContent = command;
    $('verified').hidden = false;
    // Recheck while the tab stays open, including long-lived invites beyond timer limits.
    expiryTimer = setTimeout(render, Math.min(Math.max(1, expiry - Date.now()), 60_000));
    try {
      const matrix = QRCode.create(link, { errorCorrectionLevel: 'L' }).modules;
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 0 ${matrix.size + 8} ${matrix.size + 8}`);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', w.qrTitle);
      svg.setAttribute('shape-rendering', 'crispEdges');
      const background = document.createElementNS(ns, 'rect');
      background.setAttribute('width', '100%'); background.setAttribute('height', '100%'); background.setAttribute('fill', 'white');
      svg.append(background);
      const path = document.createElementNS(ns, 'path');
      let d = '';
      for (let row = 0; row < matrix.size; row++) for (let col = 0; col < matrix.size; col++)
        if (matrix.get(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
      path.setAttribute('d', d); path.setAttribute('fill', 'black'); svg.append(path);
      $('qr').append(svg);
    } catch { $('qr').textContent = w.qrLarge; }
  } catch (error) {
    $('status').className = 'notice warning';
    $('status').textContent = error.message === 'INVITE_EXPIRED' ? w.expired : w.invalid;
  }
}

async function copy(id) {
  const w = words[japanese ? 'ja' : 'en'];
  if (id === 'command' || id === 'link') {
    try { verifyFragment(location.hash); } catch { render(); return; }
  }
  try { await navigator.clipboard.writeText(id === 'link' ? current.link : $(id).textContent); $('copy-status').textContent = w.copied; }
  catch { $('copy-status').textContent = w.copyFailed; }
}
$('language').addEventListener('click', () => { japanese = !japanese; render(); });
$('copy-install').addEventListener('click', () => copy('install'));
$('copy-command').addEventListener('click', () => copy('command'));
$('copy-link').addEventListener('click', () => copy('link'));
window.addEventListener('hashchange', render);
window.addEventListener('pageshow', render);
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
render();
