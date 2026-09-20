// 设置·供应商登录：OMP 登录流程（浏览器授权 + 粘贴码弹窗中转）、底部进度条、
// 「添加供应商」三列卡片视图与供应商详情页（登录 / API key 二选一）。
import { $, S, send, toast } from "../core.js";
import { PROV_IC } from "./index.js";

export function startProviderLogin(id) {
  if (S.loginBusy) {
    toast("已有登录流程进行中，可点击底部进度条取消");
    return;
  }
  S.loginBusy = true;
  S.loginReqId++;
  send({ type: "provider_login", provider: id, reqId: S.loginReqId });
  showLoginBanner(`${id}：正在启动登录…`);
}
// 登录进行中底部进度条:显示状态 + 取消按钮(关浏览器页后可手动中断)
export function showLoginBanner(text) {
  let b = $("loginBanner");
  if (!b) {
    b = document.createElement("div");
    b.id = "loginBanner";
    b.className = "login-banner";
    const msg = document.createElement("span");
    msg.id = "loginBannerMsg";
    const cancel = document.createElement("button");
    cancel.className = "save-btn";
    cancel.textContent = "取消登录";
    cancel.onclick = () => send({ type: "provider_login_cancel" });
    b.append(msg, cancel);
    document.body.appendChild(b);
  }
  $("loginBannerMsg").textContent = text;
}
export function hideLoginBanner() {
  $("loginBanner")?.remove();
}
// 登录流程的粘贴码弹窗(host 经 login_prompt 中转)
export function closeLoginPrompt() {
  $("loginPromptMask")?.remove();
}
// 通用二次确认弹窗：复用登录粘贴码的 lp-mask/lp-box 弹窗语言，danger 时确认钮走红。
// 返回 Promise<boolean>，点遮罩/取消均视为 false（替代原生 confirm，WKWebView 下观感统一）
export function confirmDialog({ title, message = "", confirmText = "确定", danger = false }) {
  return new Promise((resolve) => {
    $("confirmDlgMask")?.remove();
    const wrap = document.createElement("div");
    wrap.className = "lp-mask";
    wrap.id = "confirmDlgMask";
    const box = document.createElement("div");
    box.className = "lp-box";
    const t = document.createElement("div");
    t.className = "lp-msg";
    t.textContent = title;
    box.appendChild(t);
    if (message) {
      const m = document.createElement("div");
      m.className = "cf-msg";
      m.textContent = message;
      box.appendChild(m);
    }
    const row = document.createElement("div");
    row.className = "lp-row";
    const cancel = document.createElement("button");
    cancel.className = "save-btn";
    cancel.textContent = "取消";
    const ok = document.createElement("button");
    ok.className = "save-btn" + (danger ? " danger" : "");
    ok.textContent = confirmText;
    const close = (val) => {
      wrap.remove();
      resolve(val);
    };
    cancel.onclick = () => close(false);
    ok.onclick = () => close(true);
    row.append(cancel, ok);
    box.appendChild(row);
    wrap.appendChild(box);
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) close(false);
    });
    document.body.appendChild(wrap);
  });
}
export function showLoginPrompt(msg) {
  closeLoginPrompt();
  const wrap = document.createElement("div");
  wrap.className = "lp-mask";
  wrap.id = "loginPromptMask";
  const box = document.createElement("div");
  box.className = "lp-box";
  const t = document.createElement("div");
  t.className = "lp-msg";
  t.textContent = msg.message || "请输入授权码：";
  const inp = document.createElement("input");
  inp.className = "inp";
  if (msg.secret) inp.type = "password";
  inp.placeholder = "粘贴授权码或完整回调 URL";
  const row = document.createElement("div");
  row.className = "lp-row";
  const ok = document.createElement("button");
  ok.className = "save-btn";
  ok.textContent = "确定";
  const cancel = document.createElement("button");
  cancel.className = "save-btn";
  cancel.textContent = "取消";
  ok.onclick = () => {
    send({ type: "login_prompt_reply", id: msg.id, text: inp.value });
    closeLoginPrompt();
  };
  cancel.onclick = () => {
    send({ type: "login_prompt_reply", id: msg.id, text: "" });
    closeLoginPrompt();
  };
  row.append(ok, cancel);
  box.append(t, inp, row);
  wrap.appendChild(box);
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) closeLoginPrompt(); // 仅关闭弹窗,host 侧流程仍等输入
  });
  document.body.appendChild(wrap);
  inp.focus();
}

// 「添加供应商」视图:右卡三列等宽圆角卡片,列出全部受支持供应商
export function renderAddProviderView() {
  const detail = $("mpDetail");
  if (!detail) return;
  detail.replaceChildren();
  const head = document.createElement("div");
  head.className = "mp-head";
  const hb = document.createElement("b");
  hb.textContent = "＋ 添加供应商";
  head.appendChild(hb);
  detail.appendChild(head);
  const note = document.createElement("div");
  note.className = "set-group-desc";
  note.textContent = "点击供应商卡片进入详情页，可选登录或配置 API key；最后一个「手动添加供应商」走配置层 models.yml。";
  detail.appendChild(note);
  if (!S.allProvidersCache) {
    const loading = document.createElement("div");
    loading.className = "set-group-desc";
    loading.textContent = "读取中…";
    detail.appendChild(loading);
    send({ type: "get_all_providers" });
    return;
  }
  const configured = new Set(S.modelCatalog.map((m) => m.provider));
  const grid = document.createElement("div");
  grid.className = "ap-grid";
  for (const p of S.allProvidersCache) {
    const card = document.createElement("div");
    card.className = "ap-card";
    const ic = document.createElement("span");
    ic.className = "pv-ic";
    ic.textContent = PROV_IC[p.id] || "✦";
    const nm = document.createElement("span");
    nm.className = "ap-name";
    nm.textContent = p.id;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = configured.has(p.id) ? "已配置" : p.label;
    card.append(ic, nm, tag);
    // 点击进入详情页:支持登录的供应商让用户二选一(登录 / API key),仅 key 的直达表单
    card.onclick = () => {
      S.mpDetailProv = p;
      renderProviderDetail();
    };
    grid.appendChild(card);
  }
  // 末位固定卡片:手动添加 = 配置层 models.yml
  const manual = document.createElement("div");
  manual.className = "ap-card ap-manual";
  const mic = document.createElement("span");
  mic.className = "pv-ic";
  mic.textContent = "✎";
  const mnm = document.createElement("span");
  mnm.className = "ap-name";
  mnm.textContent = "手动添加供应商";
  const mtag = document.createElement("span");
  mtag.className = "tag";
  mtag.textContent = "models.yml";
  manual.append(mic, mnm, mtag);
  manual.onclick = () => {
    send({ type: "open_models_config" });
    toast("已打开 models.yml，保存后回来刷新即可");
  };
  grid.appendChild(manual);
  detail.appendChild(grid);
}
// 供应商详情页:登录 与 配置 API key 二选一
export function renderProviderDetail() {
  const detail = $("mpDetail");
  const p = S.mpDetailProv;
  if (!detail || !p) return;
  detail.replaceChildren();
  const head = document.createElement("div");
  head.className = "mp-head";
  const back = document.createElement("button");
  back.className = "save-btn";
  back.textContent = "← 返回";
  back.onclick = () => {
    S.mpDetailProv = null;
    renderAddProviderView();
  };
  const hb = document.createElement("b");
  hb.textContent = `${PROV_IC[p.id] || "✦"} ${p.id}`;
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = p.label;
  head.append(back, hb, tag);
  detail.appendChild(head);
  // 登录方式(供应商有 OMP 登录流时提供)
  if (p.login) {
    const loginCard = document.createElement("div");
    loginCard.className = "ap-card pd-login";
    const lic = document.createElement("span");
    lic.className = "pv-ic";
    lic.textContent = "🌐";
    const lnm = document.createElement("span");
    lnm.className = "ap-name";
    lnm.textContent = "登录";
    const ltag = document.createElement("span");
    ltag.className = "tag";
    ltag.textContent = "浏览器授权";
    loginCard.append(lic, lnm, ltag);
    loginCard.onclick = () => startProviderLogin(p.id);
    detail.appendChild(loginCard);
    // 分隔线:短于卡片宽度,左右不触边;不支持登录的供应商不渲染
    const div = document.createElement("div");
    div.className = "pd-div";
    detail.appendChild(div);
  }
  // API key 方式(所有供应商可用):标签在上,圆角输入框在下
  const keyWrap = document.createElement("div");
  keyWrap.className = "pd-key";
  const keyTx = document.createElement("div");
  keyTx.className = "srow-tx";
  const keyB = document.createElement("b");
  keyB.textContent = "API Key";
  const keySpan = document.createElement("span");
  keySpan.textContent = "粘贴供应商的 API key，保存后立即生效。";
  keyTx.append(keyB, keySpan);
  const keyRow = document.createElement("div");
  keyRow.className = "pd-key-row";
  const keyInp = document.createElement("input");
  keyInp.className = "inp";
  keyInp.type = "password";
  keyInp.placeholder = "sk-…";
  keyInp.id = "pdKeyInput";
  const keySave = document.createElement("button");
  keySave.className = "save-btn";
  keySave.textContent = "保存";
  keySave.onclick = () => {
    const key = keyInp.value.trim();
    if (!key) {
      toast("请输入 API key");
      return;
    }
    send({ type: "provider_set_key", provider: p.id, key });
  };
  keyRow.append(keyInp, keySave);
  keyWrap.append(keyTx, keyRow);
  detail.appendChild(keyWrap);
}
