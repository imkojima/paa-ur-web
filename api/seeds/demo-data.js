// PAA-UR — dev seed 來源資料（虛構示範內容，繁體中文）。
// 僅供 api/scripts/gen-seed.mjs 產生 seeds/0001_content.sql 使用；非前端執行期資源。
// 內容皆為示意，不含任何真實個人或機關資料。ROC year 115 = 2026

// 公告分類由 migrations/0001_init.sql 建立（一般公告／新聞稿／活動訊息）
const DEMO_NEWS = [
  {
    cat: '一般公告', date: '115.10.20', views: 36, pinned: true,
    title: '115年度補助申請等相關事項公告',
    excerpt: '115年度補助申請自即日起受理，申請資格、應備文件與受理期間詳如內文，申請書請至「檔案下載」取得。',
    body: [
      { h: '一、受理期間' },
      { p: '自中華民國115年11月1日起至116年3月31日止，額滿為止。' },
      { h: '二、應備文件' },
      { list: ['補助申請書', '建物權狀影本', '區分所有權人會議紀錄（公寓適用）'] },
    ],
    files: [{ name: '115年度補助申請須知.pdf', size: '420 KB', type: 'pdf' }],
  },
  {
    cat: '活動訊息', date: '115.10.08', views: 21,
    title: '115年度補助申請說明會開放報名',
    excerpt: '說明會將介紹補助項目、申請流程與常見問題，歡迎有意申請之民眾報名參加。',
    body: [
      { h: '說明會資訊' },
      { table: [['日期', '中華民國115年11月8日（星期六）14:00–16:00'], ['地點', '示範市區民活動中心'], ['費用', '免費']] },
    ],
  },
  {
    cat: '新聞稿', date: '115.09.30', views: 54,
    title: '示範城市推動老舊建物機能復新計畫正式啟動',
    excerpt: '計畫聚焦安全韌性、節能減碳與在地修繕服務三大主軸，協助屋齡較高之住宅延長使用年限。',
    body: [
      { p: '本計畫針對屋齡30年以上之住宅，提供結構安全、防水、管線更新等改善項目之補助與諮詢服務。' },
    ],
  },
];

const DEMO_DOWNLOADS = [
  { name: '公寓-補助申請書', cat: '公寓-補助申請表單', size: '320 KB', type: 'pdf' },
  { name: '公寓-區分所有權人同意書', cat: '公寓-補助申請表單', size: '210 KB', type: 'pdf' },
  { name: '透天住宅-補助申請書', cat: '透天住宅-補助申請表單', size: '300 KB', type: 'pdf' },
  { name: '申請流程圖', cat: '其他申請文件', size: '180 KB', type: 'pdf' },
];

const DEMO_FRIENDS = [
  { name: '內政部國土管理署', url: 'https://www.nlma.gov.tw/' },
  { name: '澎湖縣政府', url: 'https://www.penghu.gov.tw/' },
  { name: '社團法人澎湖縣建築師公會', url: 'https://www.paa.org.tw/' },
];

const DEMO_HERO = [
  {
    bg: null,
    eyebrow: 'URBAN REGENERATION',
    title: '老舊建物<br>機能復新計畫',
    desc: '安全韌性、節能減碳、在地修繕服務。',
    buttons: [
      { label: '最新消息 →', page: 'news', primary: true },
      { label: '申請書下載', page: 'downloads' },
    ],
  },
];

const DEMO_LEGAL = {
  privacy: { blocks: [{ p: '（示範內容）本網站隱私權政策，上線前請依實際營運單位改寫。' }] },
  terms: { blocks: [{ p: '（示範內容）本網站使用條款，上線前請依實際營運單位改寫。' }] },
};

// 聯絡資訊（虛構）
const DEMO_CONTACT = { address: '示範市示範區示範路 1 號', tel: '(02) 0000-0000', fax: '', email: 'service@example.com' };

Object.assign(window, { DEMO_NEWS, DEMO_DOWNLOADS, DEMO_FRIENDS, DEMO_HERO, DEMO_LEGAL, DEMO_CONTACT });
