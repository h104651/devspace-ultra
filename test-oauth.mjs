import http from 'node:http';
import { exec } from 'node:child_process';

const PORT = 8989;
const TARGET_URL = 'https://itrd-mcp.pardn.workers.dev/mcp/oauth';

console.log('=== P1Research OAuth 連線探測程式 ===');
console.log(`1. 正在嘗試用您的系統預設瀏覽器開啟端點: ${TARGET_URL}`);

// 開啟系統預設瀏覽器
exec(`start "" "${TARGET_URL}"`, (err) => {
  if (err) {
    console.error('無法開啟瀏覽器:', err);
  } else {
    console.log('2. 已開啟瀏覽器，請觀察瀏覽器畫面顯示的內容：');
    console.log('   - 是跳出 Google 登入 / 授權畫面？');
    console.log('   - 還是顯示 404 / 1042 (Worker not found) 或其他錯誤畫面？');
  }
});
