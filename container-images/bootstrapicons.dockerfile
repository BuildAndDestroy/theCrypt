FROM debian:latest
RUN apt update -y
RUN apt install npm nodejs git -y
WORKDIR "/root/"
RUN git clone https://github.com/twbs/icons/
WORKDIR "/root/icons/"
RUN npm install
