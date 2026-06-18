ARG PYTHON_IMAGE=python:3.13-slim
FROM ${PYTHON_IMAGE}

WORKDIR /app

COPY server.py ./
COPY public/ ./public/
COPY config/ ./config/

RUN mkdir -p /app/data

EXPOSE 8787

CMD ["python3", "server.py"]
