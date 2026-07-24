'use strict';
const BASE = 'https://hr-talent-285099-10-1456481392.sh.run.tcloudbase.com';
const resumeText = `张明华
男 | 1992年5月 | 13812345678 | zhangmh@example.com

求职意向：人力资源经理

教育背景
2010.09 - 2014.06  北京大学  人力资源管理  本科

工作经历
2019.07 - 至今  北京华联商厦股份有限公司  人力资源经理
负责招聘体系搭建，年招聘量300+，优化面试流程，将平均到岗周期缩短20%；主导校园招聘项目。

2016.03 - 2019.06  万达集团  招聘主管
搭建门店基层人才选拔标准，管理5人团队，完成华北区12家门店 staffing 与梯队建设。

2014.07 - 2016.02  某互联网公司  人事专员
负责员工入离职办理、社保公积金经办、员工关系维护。
`;

(async () => {
  try {
    const login = await fetch(BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    const lj = await login.json();
    if (!lj.token) { console.log('登录失败:', JSON.stringify(lj)); process.exit(1); }

    const buf = Buffer.from(resumeText, 'utf8');
    const form = new FormData();
    form.append('file', new Blob([buf]), 'resume_test.txt');

    const r = await fetch(BASE + '/api/parse-resume', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + lj.token },
      body: form
    });
    const j = await r.json();
    console.log('HTTP 状态:', r.status);
    console.log('usedLlm:', j.usedLlm);
    console.log('usedOcr:', j.usedOcr);
    console.log('llmSkipped(未配key):', j.llmSkipped);
    console.log('llmError(调用失败原因):', j.llmError || '(无)');
    console.log('提取字段:', JSON.stringify(j.fields, null, 2));
    console.log('返回文本前300字:', (j.text || '').slice(0, 300));
  } catch (e) {
    console.error('脚本出错:', e.message);
  }
})();
