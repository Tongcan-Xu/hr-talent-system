'use strict';
/**
 * resume.js —— 简历文件解析与关键信息提取
 * 支持：TXT / PDF / DOCX 文本解析 + JPG/PNG 图片 OCR（腾讯云，纯 Node 实现签名，无需大 SDK）
 * 对外导出：parseResume(buf, ext) 与 extractFields(text)
 */

const https = require('node:https');
const crypto = require('node:crypto');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

/**
 * 从简历纯文本里提取结构化字段（启发式规则）。
 * 注意：这是「预填」用途，准确度有限，前端会把结果填进表单供 HR 核对修改，不直接入库。
 */
function extractFields(text) {
  const f = {};
  const clean = (s) => (s || '').replace(/\s+/g, ' ').replace(/[，,；;]/g, ' ').trim();
  // 去除中文名内部可能由 OCR 引入的间隔空格/间隔符（如「张 三」「张·三」）
  const normCN = (s) => (s || '').replace(/[\s・•·・]/g, '');

  // 手机号（含可选的 +86 / 86 前缀）
  const phone = text.match(/(?:\+?86[-\s]?)?(1[3-9]\d{9})/);
  if (phone) f.phone = phone[1];

  // 邮箱
  const email = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (email) f.email = email[0];

  // ===== 姓名 =====
  let name = null;
  // 1) 显式标签（兼容 OCR 在姓名与字号之间产生的间隔空格）
  let m = text.match(/(?:姓\s*名|名\s*字|Name)\s*[:：]?\s*([\u4e00-\u9fa5](?:[ \t]*[\u4e00-\u9fa5]){1,3})/i);
  if (m) name = normCN(m[1]);
  // 2) 简历顶部「张三 男 28岁」或「张三/男」写法（姓名后紧跟性别）
  if (!name) {
    m = text.match(/^\s*([\u4e00-\u9fa5]{2,4})[ \t]*(?:[·•·\s]*)(?:男|女)\b/);
    if (m) name = normCN(m[1]);
  }
  // 3) 顶部独立一行 2-4 个汉字（跳过常见标题词/机构名）
  if (!name) {
    const stop = ['个人简历', '简历', '求职简历', '我的简历', '基本信息', '个人资料', '个人信息', '个人基本',
      '联系电话', '联系我们', '联系方式', 'RESUME', 'CURRICULUM', 'PROFILE', '应聘'];
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines.slice(0, 8)) {
      const cm = line.match(/^([\u4e00-\u9fa5]{2,4})$/);
      if (cm && !stop.includes(line) && !/(大学|公司|学院|医院|学校|集团|有限公司)/.test(line)) {
        name = cm[1];
        break;
      }
    }
  }
  // 4) 英文名
  if (!name) {
    m = text.match(/(?:name)\s*[:：]?\s*([A-Z][a-z]+(?:[ \t][A-Z][a-z]+)+)/i);
    if (m) name = m[1].trim();
  }
  if (name) f.name = name;

  // 应聘职位 / 求职意向
  const posM = text.match(/(?:应聘职位|求职意向|目标职位|期望职位|应聘岗位|应聘方向)\s*[:：]?\s*([^\n，。,；;]{2,24})/);
  if (posM) f.position = clean(posM[1]);

  // ===== 学历（学位）=====
  const eduMap = { '硕士研究生': '硕士', '全日制本科': '本科', '大学本科': '本科' };
  const eduM = text.match(/(?:学历|教育背景|学位)\s*[:：]?\s*(本科|硕士研究生|硕士|研究生|博士|大专|专科|全日制本科)/);
  if (eduM) f.education = eduMap[eduM[1]] || eduM[1];
  else {
    const edu2 = text.match(/(本科|硕士|研究生|博士|大专|专科)/);
    if (edu2) f.education = edu2[1];
  }

  // ===== 毕业院校（与「公司」分离，避免互相串扰）=====
  let school = null;
  m = text.match(/(?:毕业院校|毕业学校|毕业自|毕业于|就读[院学]校|院校|学校)\s*[:：]?\s*([^\n，。,；;]{2,28}?(?:大学|学院|学校|中学|Institute|University|College)[^\n，。,；;]{0,12})/i);
  if (m) school = clean(m[1]);
  if (!school) {
    m = text.match(/([\u4e00-\u9fa5]{2,14}?(?:大学|学院|学校))(?!\s*(?:生|毕业))/);
    if (m) school = m[1];
  }
  if (school) f.school = school;

  // ===== 当前公司（仅匹配公司类标签，避免误抓学校）=====
  m = text.match(/(?:现任职于|就职于|任职于|所在公司|当前公司|公司名称|公司)\s*[:：]?\s*([^\n，。,；;]{2,24})/);
  if (m) {
    f.current_org = clean(m[1])
      .replace(/^于[ \t]*/, '')
      .replace(/(?:\s*(?:高级|资深|初级|中级|技术|工程师|经理|总监|主管|专员|专家|负责人|助理|员|生))+$/, '');
  }

  // 期望薪资
  const salM = text.match(/(?:期望薪资|薪资要求|薪酬要求|期望薪酬|薪资)\s*[:：]?\s*([^\n，。,；;]{1,16})/);
  if (salM) f.expected_salary = clean(salM[1]);

  return f;
}

/**
 * 把文件二进制内容解析成纯文本。
 * ext 为带点的扩展名，如 .pdf / .docx / .txt / .jpg
 */
async function parseBuffer(buf, ext) {
  ext = (ext || '').toLowerCase();
  if (ext === '.txt') return buf.toString('utf8');
  if (ext === '.pdf') {
    const d = await pdfParse(buf);
    return d.text || '';
  }
  if (ext === '.docx') {
    const r = await mammoth.extractRawText({ buffer: buf });
    return r.value || '';
  }
  throw new Error('不支持的文件类型：' + ext + '（仅支持 PDF / DOCX / TXT / JPG / PNG）');
}

// ============ 腾讯云 OCR（TC3-HMAC-SHA256 签名，纯 Node 实现）============
function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function hmac(key, s) { return crypto.createHmac('sha256', key).update(s, 'utf8').digest(); }

/**
 * 调用腾讯云通用印刷体识别，返回拼接后的文本。
 * 需要环境变量 TENCENT_SECRET_ID / TENCENT_SECRET_KEY；可选 TENCENT_OCR_REGION（默认 ap-beijing）。
 */
function ocrImage(buf) {
  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;
  if (!secretId || !secretKey) {
    const e = new Error('未配置腾讯云 OCR 密钥：请在 CloudBase 环境变量中设置 TENCENT_SECRET_ID 与 TENCENT_SECRET_KEY');
    e.code = 'NO_OCR_KEY';
    throw e;
  }
  const b64 = buf.toString('base64');
  const payload = JSON.stringify({ ImageBase64: b64 });
  const host = 'ocr.tencentcloudapi.com';
  const service = 'ocr';
  const action = 'GeneralBasicOCR';
  const version = '2018-11-19';
  const region = process.env.TENCENT_OCR_REGION || 'ap-beijing';
  const algorithm = 'TC3-HMAC-SHA256';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const hashedPayload = sha256(payload);
  const canonicalRequest = [
    'POST', '/', '',
    canonicalHeaders, signedHeaders, hashedPayload
  ].join('\n');

  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    algorithm, timestamp, credentialScope, sha256(canonicalRequest)
  ].join('\n');

  const secretDate = hmac('TC3' + secretKey, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const headers = {
    'Authorization': authorization,
    'Content-Type': 'application/json; charset=utf-8',
    'Host': host,
    'X-TC-Action': action,
    'X-TC-Version': version,
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Region': region,
  };

  return new Promise((resolve, reject) => {
    const req = https.request({ host, path: '/', method: 'POST', headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.Response && json.Response.Error) {
            return reject(new Error('腾讯云 OCR 错误：' + json.Response.Error.Message));
          }
          const lines = (json.Response && json.Response.TextDetections || []).map((t) => t.DetectedText);
          resolve(lines.join('\n'));
        } catch (e) {
          reject(new Error('OCR 响应解析失败：' + body.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * 统一入口：根据扩展名解析文件为文本，并提取字段。
 * 返回 { text, fields, usedOcr }
 */
async function parseResume(buf, ext) {
  const imgExts = ['.jpg', '.jpeg', '.png', '.bmp', '.gif'];
  let text = '';
  let usedOcr = false;
  if (imgExts.includes(ext.toLowerCase())) {
    text = await ocrImage(buf);
    usedOcr = true;
  } else {
    text = await parseBuffer(buf, ext);
  }
  const fields = extractFields(text);
  return { text: text.slice(0, 8000), fields, usedOcr };
}

module.exports = { extractFields, parseBuffer, ocrImage, parseResume };
