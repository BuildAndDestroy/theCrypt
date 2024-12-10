# Stage 1: Build Bootstrap
FROM debian:latest
RUN apt update -y
RUN apt install npm nodejs git -y
WORKDIR "/root/"
RUN git clone https://github.com/twbs/bootstrap.git
WORKDIR "/root/bootstrap/"
RUN npm install
RUN npm run dist
