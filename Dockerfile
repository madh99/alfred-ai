FROM node:24-slim
WORKDIR /app
COPY packages/cli/bundle/index.js .
COPY package.json .
RUN npm install --omit=dev
ENV NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "const h=require('http');h.get('http://localhost:3420/api/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{const j=JSON.parse(d);process.exit(j.status==='ok'?0:1)})}).on('error',()=>process.exit(1))"
EXPOSE 3420
CMD ["node", "index.js", "start"]
