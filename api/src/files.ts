// 附件／檔案下載時實際使用的檔名。
//
// DB 存的 name 是給人看的標題，後台上傳時會自動帶入檔名但去掉副檔名（見 web/admin/admin.js
// 的 fillCol 邏輯），讓「檔名」欄位可以是「115年度會員大會會議記錄」這種乾淨的標題。
// 但 Content-Disposition 直接拿 name 當下載檔名的話，存下來的檔案會沒有副檔名，
// 部分作業系統因此不知道要用什麼程式開啟。這裡從實體檔案路徑（R2 key，保留原始副檔名）補回來——
// 對應前台 app.js 的 dlName()，公開下載走 /files/* 那條路已經靠它補過，這裡補齊後台認證下載的部分。
export function attachmentFilename(name: string, filePath: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(filePath || '');
  if (!m) return name;
  return new RegExp('\\.' + m[1] + '$', 'i').test(name) ? name : `${name}.${m[1]}`;
}
