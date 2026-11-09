-- 縣府退件修正（府建管字第1150065778號，115/10/28）：補齊函文三（一）至（四）要求的網站內容。
--   1. 頁面管理（pages）：計畫說明、補助辦法、申請流程、聯絡窗口四頁，後台可編修
--   2. 常見問答（faq_categories / faqs）：函文指定的五類
--   3. 線上諮詢收件匣（inquiries）：網站提問表單＋值班人員登錄的 LINE 案件
--   4. 公告分類「宣導資訊」、檔案分類「說明會簡報」「宣傳手冊／摺頁」
--   5. 設定：consult（LINE 連結、值班時段、回覆時限）、contact 補服務時間
-- 內容取自內政部國土管理署宣導說明會簡報、本計畫摺頁與海報；上線前須送縣府確認。
-- 所有種子資料只在「尚無資料」時寫入，不覆蓋後台已改過的內容。

-- ── 常見問答 ───────────────────────────────────────────────
CREATE TABLE faq_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE faqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES faq_categories(id),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,        -- HTML（TinyMCE）
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_faqs_category ON faqs(category_id, sort_order);

-- ── 線上諮詢 ───────────────────────────────────────────────
-- channel：web＝網站表單（自動進件）、line＝值班人員把 LINE 案件登錄進來、phone＝電話來電登錄。
-- category 存問題類別名稱（與常見問答分類同名，月報統計用），不設外鍵：分類改名不影響舊案件。
CREATE TABLE inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL DEFAULT 'web' CHECK (channel IN ('web','line','phone')),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  township TEXT,
  building_type TEXT,          -- 公寓／透天／不確定
  category TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','processing','replied','closed')),
  reply TEXT,
  note TEXT,                   -- 內部備註（轉介紀錄等），不對外
  replied_by INTEGER REFERENCES admin_users(id),
  replied_at TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_inquiries_status ON inquiries(status, created_at);
CREATE INDEX idx_inquiries_created ON inquiries(created_at);

-- ── 分類補齊 ───────────────────────────────────────────────
INSERT INTO announcement_categories (name, color, scope, sort_order)
  SELECT '宣導資訊', '#7a4e9c', 'public', 4
  WHERE NOT EXISTS (SELECT 1 FROM announcement_categories WHERE name='宣導資訊');

INSERT INTO document_categories (name, access_scope, sort_order)
  SELECT '說明會簡報', 'public', 10
  WHERE NOT EXISTS (SELECT 1 FROM document_categories WHERE name='說明會簡報');
INSERT INTO document_categories (name, access_scope, sort_order)
  SELECT '宣傳手冊／摺頁', 'public', 11
  WHERE NOT EXISTS (SELECT 1 FROM document_categories WHERE name='宣傳手冊／摺頁');

INSERT INTO faq_categories (name, sort_order) VALUES
  ('申請資格', 1), ('補助項目', 2), ('申請程序', 3), ('審查作業', 4), ('其他', 5);

-- ── 設定 ───────────────────────────────────────────────────
INSERT INTO settings ("key", "value") VALUES ('consult', json_object(
  'line_url', '',
  'line_id', '',
  'hours', '',
  'reply_sla', '2 個工作天內',
  'notify_email', ''
)) ON CONFLICT("key") DO NOTHING;

-- 聯絡資訊：尚未在後台設定過（地址仍空白）才帶入執行單位資料（取自本計畫摺頁）
UPDATE settings SET "value" = json_object(
  'address', '澎湖縣馬公市中興路 13 號',
  'tel', '06-927-1112',
  'fax', COALESCE(json_extract("value", '$.fax'), ''),
  'email', 'penghu9271112@gmail.com'
) WHERE "key"='contact' AND COALESCE(json_extract("value", '$.address'), '')='';
UPDATE settings SET "value" = json_insert("value", '$.hours', '') WHERE "key"='contact';

-- ── 頁面 ───────────────────────────────────────────────────
INSERT INTO pages (slug, title, body, status, sort_order) VALUES ('plan', '計畫說明',
  '<h2>一、計畫緣起</h2>'
  || '<p>臺灣面臨「人、屋雙老」的挑戰：屋齡 30 年以上的住宅比例逐年提高，許多老屋缺乏電梯與無障礙設施，長者出入不便；澎湖又屬高鹽、強風、潮濕的海島氣候，外牆剝落、屋頂滲漏、管線鏽蝕等劣化問題更為常見。</p>'
  || '<p>「老宅延壽機能復新計畫」以修繕取代拆除重建，補助老舊住宅進行結構安全評估、公共設施與室內機能改善，讓長者能在熟悉的家中安心終老（人在地安養），也讓房屋延長使用年限、減少營建廢棄物與碳排放（屋淨零減碳）。</p>'
  || '<h2>二、三大推動主軸</h2>'
  || '<h3>（一）提升建築安全韌性及改善建築物機能</h3>'
  || '<p>補助外牆整修、屋頂防水止漏、公共管線更新，以及增設電梯、無障礙設施等高齡友善改善。</p>'
  || '<h3>（二）結合節能減碳與淨零轉型</h3>'
  || '<p>以修繕延長建築物使用年限，鼓勵汰換老舊設備，提升住宅能源效率。</p>'
  || '<h3>（三）促進在地修繕服務與生活機能改善</h3>'
  || '<p>由在地建築師組成地方服務團，提供諮詢、申請輔導與施工品質輔導。</p>'
  || '<h2>三、計畫基本資料</h2>'
  || '<table style="border-collapse:collapse;width:100%" border="1"><tbody>'
  || '<tr><th>經費來源</th><td>中央特別預算</td></tr>'
  || '<tr><th>計畫期程</th><td>至 116 年 12 月 31 日止</td></tr>'
  || '<tr><th>指導單位</th><td>內政部國土管理署</td></tr>'
  || '<tr><th>主辦單位</th><td>澎湖縣政府</td></tr>'
  || '<tr><th>執行單位</th><td>社團法人澎湖縣建築師公會（地方服務團）</td></tr>'
  || '</tbody></table>'
  || '<p>補助對象、項目與額度請見「<a href="/subsidy">補助辦法</a>」，申請步驟請見「<a href="/process">申請流程</a>」。</p>',
  'published', 1) ON CONFLICT(slug) DO NOTHING;

INSERT INTO pages (slug, title, body, status, sort_order) VALUES ('subsidy', '補助辦法',
  '<p>本頁為補助內容摘要，實際規定以中央主管機關發布之補助辦法及澎湖縣政府公告為準。</p>'
  || '<h2>一、申請資格</h2>'
  || '<table style="border-collapse:collapse;width:100%" border="1"><tbody>'
  || '<tr><th>建築物</th><td>屋齡 30 年以上的合法建築物（領有使用執照，或經地方主管機關認定屬合法建物）。</td></tr>'
  || '<tr><th>4～6 層樓公寓</th><td>由公寓大廈管理委員會或管理負責人申請；或經全體區分所有權人 100% 同意，共同推派代表人申請。建築物超過 1/2 作住宅使用。申請公共空間共有部分修繕時，戶籍內至少 1 人為 65 歲以上長者、低收或中低收入戶，或長照需要等級第 2 級以上且符合居家無障礙環境改善補助對象。</td></tr>'
  || '<tr><th>6 樓以下透天住宅</th><td>經全體所有權人 100% 同意，共同推派代表人申請；全棟作住宅使用；補助對象不得為法人。</td></tr>'
  || '</tbody></table>'
  || '<h3>不予補助的情形</h3>'
  || '<ul>'
  || '<li>公寓全棟為單一所有權人持有。</li>'
  || '<li>已申請建造執照、拆除執照，或經地方政府認定須拆除。</li>'
  || '<li>已進入都市更新或危老重建程序（已報核或已申請）。</li>'
  || '<li>已申請其他相同補助項目。</li>'
  || '</ul>'
  || '<h2>二、結構安全性能評估補助</h2>'
  || '<p>初步評估與詳細評估二擇一；先前已完成的評估結果可以沿用，免再次評估，但不得重複補助。</p>'
  || '<table style="border-collapse:collapse;width:100%" border="1"><thead><tr><th>評估類別</th><th>補助額度</th></tr></thead><tbody>'
  || '<tr><td>初步評估</td><td>每棟 12,000 元（總樓地板面積未滿 3,000 平方公尺）或 15,000 元（3,000 平方公尺以上）</td></tr>'
  || '<tr><td>詳細評估</td><td>評估費用 30% 或 40 萬元</td></tr>'
  || '</tbody></table>'
  || '<h2>三、公寓修繕補助</h2>'
  || '<h3>（一）公共空間共有部分（至少選 3 項）</h3>'
  || '<table style="border-collapse:collapse;width:100%" border="1"><thead><tr><th>補助項目</th><th>補助上限</th></tr></thead><tbody>'
  || '<tr><td>增設昇降設備</td><td>400 萬元／棟</td></tr>'
  || '<tr><td>建築物立面修繕</td><td>300 萬元／棟</td></tr>'
  || '<tr><td>公共管線修繕更新</td><td>50 萬元／棟</td></tr>'
  || '<tr><td>屋頂防水及隔熱</td><td>50 萬元／棟</td></tr>'
  || '<tr><td>樓梯間修繕</td><td>40 萬元／棟</td></tr>'
  || '<tr><td>老舊招牌違規物拆除</td><td>40 萬元／棟</td></tr>'
  || '<tr><td>外掛式空調安全改善</td><td>40 萬元／棟</td></tr>'
  || '<tr><td>無障礙設施</td><td>40 萬元／棟</td></tr>'
  || '</tbody></table>'
  || '<h3>（二）私人室內專有部分（可加選）</h3>'
  || '<p>每戶補助上限 20 萬元；戶籍內有高齡或弱勢者（見下方「加碼補助」），上限提高為每戶 30 萬元。</p>'
  || '<h3>（三）作業費用</h3>'
  || '<p>委託專業者協助辦理，公寓共用部分每棟補助 1 萬元；申請增設昇降設備、建築物立面修繕者各加碼 5 萬元／棟，最高 11 萬元。</p>'
  || '<h2>四、透天住宅修繕補助</h2>'
  || '<h3>（一）室外部分（至少選 1 項）</h3>'
  || '<table style="border-collapse:collapse;width:100%" border="1"><thead><tr><th>補助項目</th><th>補助上限</th></tr></thead><tbody>'
  || '<tr><td>建築物立面修繕</td><td>1～2 層 100 萬元、3～4 層 200 萬元、5～6 層 300 萬元／棟</td></tr>'
  || '<tr><td>屋頂防水及隔熱</td><td>20 萬元／棟</td></tr>'
  || '<tr><td>外掛式空調安全改善</td><td>5 萬元／棟</td></tr>'
  || '<tr><td>室外無障礙設施</td><td>5 萬元／棟</td></tr>'
  || '</tbody></table>'
  || '<h3>（二）室內部分（可加選）</h3>'
  || '<p>每戶補助上限 20 萬元；符合加碼條件者提高為每戶 30 萬元。</p>'
  || '<h2>五、補助比例與加碼</h2>'
  || '<ul>'
  || '<li>各項補助以實際修繕經費的 <strong>65%</strong> 為上限，且不超過各項額度。</li>'
  || '<li><strong>加碼補助：</strong>戶籍內有 65 歲以上長者、低收或中低收入戶，或長照需要等級第 2 級以上且符合居家無障礙環境改善補助對象者，室內補助上限提高為每戶 30 萬元。</li>'
  || '<li>修繕主要建材（如建築立面、磁磚、混凝土）限用國產品牌。</li>'
  || '</ul>'
  || '<h2>六、優先審查加分項目</h2>'
  || '<p>申請件數超過預算時，依符合下列項目的多寡排序，超出預算者列為備取：</p>'
  || '<ol>'
  || '<li>戶籍內有高齡或弱勢者。</li>'
  || '<li>外牆磁磚剝落並申請立面修繕。</li>'
  || '<li>加裝太陽能光電板（立面型）。</li>'
  || '<li>提供包租代管社會住宅。</li>'
  || '<li>透天連棟式 3 棟以上共同申請。</li>'
  || '<li>公寓共用部分申請項目超過 4 項，或透天室外申請項目超過 2 項。</li>'
  || '</ol>'
  || '<h2>七、可搭配的其他補助</h2>'
  || '<p>可搭配經濟部（老舊家電汰換、屋頂太陽光電）、衛生福利部（長照居家無障礙環境改善）等資源，但相同項目不得重複申請。</p>',
  'published', 2) ON CONFLICT(slug) DO NOTHING;

INSERT INTO pages (slug, title, body, status, sort_order) VALUES ('process', '申請流程',
  '<ol class="ur-steps">'
  || '<li><h3>向縣府提出申請</h3><p>於澎湖縣政府公告的受理期間內（原則為 3 個月）備齊文件提出申請。應備表單請至「<a href="/downloads">資料下載</a>」下載。</p></li>'
  || '<li><h3>縣府審查</h3><p>縣府原則於 3 個月內完成審查：受理期間先做資格初審並批次公告結果；受理結束後彙整合格名單，依優先審查項目排序，進行實質內容審查，確認預算範圍後正式函文核定。資料不齊者將限期通知補正。</p></li>'
  || '<li><h3>核定補助、施工</h3><p>核定後即可施工，原則於 1 年內完工；有正當理由得申請展期 6 個月，以 2 次為限。</p></li>'
  || '<li><h3>施工成果審查</h3><p>完工後將施工成果送縣府審查並備查。</p></li>'
  || '<li><h3>請款</h3><p>備查後向縣府請款。撥款期別與比例依縣府規定辦理。</p></li>'
  || '</ol>'
  || '<h2>地方服務團可以協助您</h2>'
  || '<p>本計畫執行單位社團法人澎湖縣建築師公會組成地方服務團，提供：</p>'
  || '<ul>'
  || '<li>在地建築師諮詢與輔導，協助盤點修繕需求</li>'
  || '<li>協助準備申請文件</li>'
  || '<li>施工品質輔導</li>'
  || '</ul>'
  || '<p>有任何問題，歡迎先查閱「<a href="/faq">常見問答</a>」，或透過「<a href="/consult">線上諮詢</a>」提問。</p>',
  'published', 3) ON CONFLICT(slug) DO NOTHING;

INSERT INTO pages (slug, title, body, status, sort_order) VALUES ('contact', '聯絡窗口',
  '<table style="border-collapse:collapse;width:100%" border="1"><thead><tr><th>單位</th><th>聯絡資訊</th></tr></thead><tbody>'
  || '<tr><td><strong>執行單位</strong><br>社團法人澎湖縣建築師公會</td><td>電話：06-927-1112<br>地址：澎湖縣馬公市中興路 13 號<br>Email：penghu9271112@gmail.com</td></tr>'
  || '<tr><td><strong>主辦單位</strong><br>澎湖縣政府建設處</td><td>地址：澎湖縣馬公市治平路 32 號</td></tr>'
  || '<tr><td><strong>指導單位</strong><br>內政部國土管理署</td><td>中央諮詢專線：02-7701-9919（週一至週五 08:00–17:00）</td></tr>'
  || '</tbody></table>',
  'published', 4) ON CONFLICT(slug) DO NOTHING;

-- ── 常見問答初稿 ───────────────────────────────────────────
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='申請資格'), '什麼樣的房屋可以申請？',
  '<p>屋齡 30 年以上的合法建築物（領有使用執照，或經地方主管機關認定屬合法建物），且為 4～6 層樓公寓或 6 樓以下透天住宅。</p>', 1);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='申請資格'), '公寓要由誰提出申請？',
  '<p>公寓大廈管理委員會或管理負責人；或由全體區分所有權人 100% 同意，共同推派代表人。</p>', 2);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='申請資格'), '透天住宅要由誰提出申請？',
  '<p>全體所有權人 100% 同意，共同推派代表人。須全棟作住宅使用，補助對象不得為法人。</p>', 3);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='申請資格'), '公寓「超過 1/2 作住宅使用」怎麼計算？',
  '<p>依使用執照登載住宅使用的戶數或樓地板面積計算。申請公共空間共有部分修繕時，另須戶籍內至少有 1 人為 65 歲以上長者、低收或中低收入戶，或長照需要等級第 2 級以上且符合居家無障礙環境改善補助對象。</p>', 4);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='申請資格'), '哪些情形不能補助？',
  '<p>公寓全棟為單一所有權人持有；已請建照、拆照或經地方政府認定須拆除；已進入都更危老程序（已報核或已申請）；已申請其他相同補助項目。</p>', 5);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='補助項目'), '公寓可以補助哪些項目？',
  '<p>公共空間共有部分至少選 3 項：增設昇降設備 400 萬元／棟、建築物立面修繕 300 萬元／棟、公共管線修繕更新及屋頂防水及隔熱各 50 萬元／棟，樓梯間修繕、老舊招牌違規物拆除、外掛式空調安全改善、無障礙設施各 40 萬元／棟。私人室內專有部分可加選，每戶 20 萬元。詳見「<a href="/subsidy">補助辦法</a>」。</p>', 1);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='補助項目'), '透天住宅可以補助哪些項目？',
  '<p>室外至少選 1 項：立面修繕（1～2 層 100 萬元、3～4 層 200 萬元、5～6 層 300 萬元／棟）、屋頂防水及隔熱 20 萬元／棟、外掛式空調安全改善及室外無障礙設施各 5 萬元／棟。室內可加選，每戶 20 萬元。</p>', 2);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='補助項目'), '補助比例上限是多少？',
  '<p>各項實際修繕經費的 65%，且不超過各項額度上限。</p>', 3);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='補助項目'), '什麼情況有加碼補助？',
  '<p>戶籍內有 65 歲以上長者、低收或中低收入戶，或長照需要等級第 2 級以上且符合居家無障礙環境改善補助對象者，室內補助上限提高為每戶 30 萬元。</p>', 4);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='補助項目'), '結構安全性能評估怎麼補助？',
  '<p>初步評估與詳細評估二擇一。初步評估每棟 12,000 元（未滿 3,000 平方公尺）或 15,000 元（3,000 平方公尺以上）；詳細評估為評估費 30% 或 40 萬元。</p>', 5);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='補助項目'), '之前做過結構評估，可以直接用嗎？',
  '<p>原評估結果可以沿用，免再次評估，但不得重複補助。</p>', 6);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='補助項目'), '公寓委託專業者協助有補助嗎？',
  '<p>有。公寓共用部分作業費用每棟 1 萬元；申請增設昇降設備、建築物立面修繕者各加碼 5 萬元／棟，最高 11 萬元。</p>', 7);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='申請程序'), '申請流程有哪些步驟？',
  '<p>向縣府申請 → 縣府審查 → 核定補助、施工 → 施工成果送審備查 → 請款。詳見「<a href="/process">申請流程</a>」。</p>', 1);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='申請程序'), '什麼時候可以申請？',
  '<p>依縣府年度公告的受理期間（原則為 3 個月），請留意「<a href="/news">最新公告</a>」。</p>', 2);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='申請程序'), '一定要找建築師嗎？',
  '<p>建議委由建築師辦理，確保安全與權益。本計畫地方服務團可提供在地建築師諮詢與輔導。</p>', 3);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='申請程序'), '施工有期限嗎？',
  '<p>原則 1 年內完工，得申請展期 6 個月，以 2 次為限。</p>', 4);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='申請程序'), '補助款怎麼撥付？',
  '<p>依縣府規定分期撥付，原則為核定後撥付評估補助及第 1 期，完工備查後請款撥付第 2 期。</p>', 5);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='申請程序'), '建材有限制嗎？',
  '<p>修繕主要建材（如建築立面、磁磚、混凝土）限用國產品牌。</p>', 6);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='審查作業'), '審查要多久？',
  '<p>縣府原則於 3 個月內完成審查。</p>', 1);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='審查作業'), '審查分哪些階段？',
  '<p>受理期間先做資格初審並批次公告結果；受理結束後彙整合格名單，依評定項目排序，進行實質內容審查，確認預算範圍後正式函文核定。</p>', 2);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='審查作業'), '資料不齊或不符合怎麼辦？',
  '<p>縣府會限期通知補正；逾期或無法補正者駁回或不予核定。</p>', 3);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='審查作業'), '申請件數超過預算時怎麼排序？',
  '<p>依六大優先審查加分項目符合多寡排序：戶籍內有高齡弱勢者、外牆磁磚剝落並申請立面修繕、加裝太陽能光電板（立面型）、提供包租代管社會住宅、透天連棟式 3 棟以上共同申請、公寓共用申請項目超過 4 項或透天室外申請項目超過 2 項。超出預算者列為備取。</p>', 4);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='其他'), '計畫到什麼時候？',
  '<p>至 116 年 12 月 31 日止。</p>', 1);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='其他'), '可以同時申請其他部會的補助嗎？',
  '<p>可搭配經濟部（老舊家電汰換、屋頂太陽光電）、衛福部（長照居家無障礙環境改善）等資源，但相同項目不得重複申請。</p>', 2);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='其他'), '哪裡可以查詢結構安全性能評估機構？',
  '<p>可參考中央主管機關公告的共同供應契約機構名冊（都市更新入口網老宅延壽專區），自行聯繫辦理。</p>', 3);
INSERT INTO faqs (category_id, question, answer, sort_order) VALUES ((SELECT id FROM faq_categories WHERE name='其他'), '還有問題可以問誰？',
  '<p>可使用本網站「<a href="/consult">線上諮詢</a>」，或洽本計畫執行單位澎湖縣建築師公會（06-927-1112）。</p>', 4);
