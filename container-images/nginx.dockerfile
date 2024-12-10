FROM nginx

COPY --from=image /root/icons/font /usr/share/nginx/html
COPY --from=image /root/bootstrap/dist /usr/share/nginx/html
COPY ./website /usr/share/nginx/html

EXPOSE 80
