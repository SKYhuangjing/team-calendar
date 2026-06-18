ARG PYTHON_IMAGE=python:3.13-slim
FROM ${PYTHON_IMAGE}

WORKDIR /app

COPY server.py ./
COPY public/ ./public/
COPY config/ ./config/

RUN mkdir -p /app/data

# 绑定 0.0.0.0，使容器内服务可从宿主机/外部访问
ENV HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

CMD ["python3", "server.py"]
