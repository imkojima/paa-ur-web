-- DEV demo 內容（由 api/seeds/demo-data.js 產生；勿手動編輯，改 gen-seed.mjs）
-- 插入順序已符合外鍵相依（父表先、子表後、查表用子查詢）。公告分類與法律頁面列由 migration 建立。
INSERT INTO announcements (id,visibility,category_id,title,excerpt,body,publish_date,views,is_pinned,show_in_list,status,published_at) VALUES (1,'public',(SELECT id FROM announcement_categories WHERE name='一般公告' AND scope='public'),'115年度補助申請等相關事項公告','115年度補助申請自即日起受理，申請資格、應備文件與受理期間詳如內文，申請書請至「檔案下載」取得。','[{"h":"一、受理期間"},{"p":"自中華民國115年11月1日起至116年3月31日止，額滿為止。"},{"h":"二、應備文件"},{"list":["補助申請書","建物權狀影本","區分所有權人會議紀錄（公寓適用）"]}]','2026-10-20',36,1,1,'published','2026-10-20');
INSERT INTO attachments (owner_type,owner_id,name,file_path,size_bytes,type,sort_order) VALUES ('announcement',1,'115年度補助申請須知.pdf','seed/115年度補助申請須知.pdf',430080,'pdf',0);
INSERT INTO announcements (id,visibility,category_id,title,excerpt,body,publish_date,views,is_pinned,show_in_list,status,published_at) VALUES (2,'public',(SELECT id FROM announcement_categories WHERE name='活動訊息' AND scope='public'),'115年度補助申請說明會開放報名','說明會將介紹補助項目、申請流程與常見問題，歡迎有意申請之民眾報名參加。','[{"h":"說明會資訊"},{"table":[["日期","中華民國115年11月8日（星期六）14:00–16:00"],["地點","示範市區民活動中心"],["費用","免費"]]}]','2026-10-08',21,0,1,'published','2026-10-08');
INSERT INTO announcements (id,visibility,category_id,title,excerpt,body,publish_date,views,is_pinned,show_in_list,status,published_at) VALUES (3,'public',(SELECT id FROM announcement_categories WHERE name='新聞稿' AND scope='public'),'示範城市推動老舊建物機能復新計畫正式啟動','計畫聚焦安全韌性、節能減碳與在地修繕服務三大主軸，協助屋齡較高之住宅延長使用年限。','[{"p":"本計畫針對屋齡30年以上之住宅，提供結構安全、防水、管線更新等改善項目之補助與諮詢服務。"}]','2026-09-30',54,0,1,'published','2026-09-30');
INSERT INTO document_categories (name,access_scope,sort_order) VALUES ('公寓-補助申請表單','public',0);
INSERT INTO document_categories (name,access_scope,sort_order) VALUES ('透天住宅-補助申請表單','public',1);
INSERT INTO document_categories (name,access_scope,sort_order) VALUES ('其他申請文件','public',2);
INSERT INTO documents (name,description,publish_date,category_id,access,file_path,size_bytes,type,is_active,sort_order) VALUES ('公寓-補助申請書',NULL,NULL,(SELECT id FROM document_categories WHERE name='公寓-補助申請表單'),'public',NULL,327680,'pdf',1,0);
INSERT INTO documents (name,description,publish_date,category_id,access,file_path,size_bytes,type,is_active,sort_order) VALUES ('公寓-區分所有權人同意書',NULL,NULL,(SELECT id FROM document_categories WHERE name='公寓-補助申請表單'),'public',NULL,215040,'pdf',1,1);
INSERT INTO documents (name,description,publish_date,category_id,access,file_path,size_bytes,type,is_active,sort_order) VALUES ('透天住宅-補助申請書',NULL,NULL,(SELECT id FROM document_categories WHERE name='透天住宅-補助申請表單'),'public',NULL,307200,'pdf',1,2);
INSERT INTO documents (name,description,publish_date,category_id,access,file_path,size_bytes,type,is_active,sort_order) VALUES ('申請流程圖',NULL,NULL,(SELECT id FROM document_categories WHERE name='其他申請文件'),'public',NULL,184320,'pdf',1,3);
INSERT INTO friend_links (name,url,is_active,sort_order) VALUES ('內政部國土管理署','https://www.nlma.gov.tw/',1,0);
INSERT INTO friend_links (name,url,is_active,sort_order) VALUES ('澎湖縣政府','https://www.penghu.gov.tw/',1,1);
INSERT INTO friend_links (name,url,is_active,sort_order) VALUES ('社團法人澎湖縣建築師公會','https://www.paa.org.tw/',1,2);
INSERT INTO hero_slides (background_image,eyebrow,title,description,buttons,is_active,sort_order) VALUES (NULL,'URBAN REGENERATION','老舊建物<br>機能復新計畫','安全韌性、節能減碳、在地修繕服務。','[{"label":"最新消息 →","target_page":"news","target_arg":null,"is_primary":true},{"label":"申請書下載","target_page":"downloads","target_arg":null,"is_primary":false}]',1,0);
UPDATE legal_pages SET blocks='[{"p":"（示範內容）本網站隱私權政策，上線前請依實際營運單位改寫。"}]' WHERE "key"='privacy';
UPDATE legal_pages SET blocks='[{"p":"（示範內容）本網站使用條款，上線前請依實際營運單位改寫。"}]' WHERE "key"='terms';
UPDATE settings SET "value"='{"address":"示範市示範區示範路 1 號","tel":"(02) 0000-0000","fax":"","email":"service@example.com"}' WHERE "key"='contact';
