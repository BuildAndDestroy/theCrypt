#!/bin/bash

docker build -t bootstrap-build -f container-images/bootstrap.dockerfile .
docker build -t bootstrapicons -f container-images/bootstrapicons.dockerfile .
docker build -t customcssjs -f customcssjs.dockerfile .
docker build -t registry.yourregistry.com/thecrypt-website -f Dockerfile .
