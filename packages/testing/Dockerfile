# Fake OpenAI-compatible server for compose.e2e.yml. Build context is the repo root. Node 24 runs the .ts directly.
FROM node:24-slim
WORKDIR /app
COPY packages/testing/src src
COPY packages/testing/fixtures fixtures
ENV PORT=4010 NODE_ENV=production
EXPOSE 4010
USER node
CMD ["node", "src/fake-openai-server.ts"]
