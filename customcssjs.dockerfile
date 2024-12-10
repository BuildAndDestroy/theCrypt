FROM debian:latest
RUN apt update -y
RUN apt install npm nodejs git -y
WORKDIR "/root/"
COPY ./website /root/website
WORKDIR "/root/website/css"
RUN npm install -g clean-css-cli
RUN cleancss -o custom-styles.min.css custom-styles.css
WORKDIR "/root/website/js"
RUN npm install -g terser
RUN terser countdown.js -o countdown.min.js --compress --mangle
