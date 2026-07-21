# 人才管理系统 - 可移植部署镜像
# 适用于：腾讯云 CloudBase 云托管 / 轻量应用服务器 / 公司内网服务器（Docker 通用）
FROM node:22-alpine

WORKDIR /app

# 先装依赖（利用 Docker 缓存，仅在 package.json 变动时才重装）
COPY package*.json ./
RUN npm install --omit=dev

# 拷贝全部源码
COPY . .

# 服务监听 0.0.0.0:3000（server.js 已配置，端口读环境变量 PORT）
EXPOSE 3000

# 启动：node server.js 会自动读取环境变量 DATABASE_URL 连接数据库
CMD ["node", "server.js"]
