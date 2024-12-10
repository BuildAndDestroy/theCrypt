# The Crypt

Threat simulation - a website to replicate a threat actor using hidden services

<h1 align="center">
<br>
<img src=assets/onion-graveyard.png>
<br>
The Crypt
</h1>


## Liability

Think before you type, I am not responsible for the misuse of this tool.
This project is specifically for threat emulation and helping Red/Blue/Purple Teams with their objectives.
If you found this tool useful, pay it forward and help the next person out.

## Description

This repo helps build and deploy Tor hidden services to Kubernetes.
A demo website exists, free to modify as you need for your engagements.

## How To

### Tor Service

* Changes will be comignto this process. But for now, this will get you up and running.

* Build your Tor image and run it

```
docker build -t tor-hidden-service -f tor.dockerfile .

docker run --rm -it tor-hidden-service bash
```

 * Copy the hidden_services directory out, we need this for our static content image

```
docker container ls # Looking for our running container

docker cp 6dec71510a4c:/etc/tor/torrc tor/

docker cp 6dec71510a4c:/var/lib/tor/hidden_service tor/
```

Your onion link will live in `tor/hidden_service/hostname`

### Kubernetes Deployment

* Build the website and hidden service
* Make sure to update the last image with your repository name

```
./build_all.sh
```

* Deploy the CRD and deployment

```
kubectl apply -f crd.yaml

kubectl apply -f deployment-no-ingress.yaml
```

Note: I have left deployment.yaml so if you decide to also run the website as a clearnet website, you can route to Tor and the clearnet.

# Examples:

```
$ kubectl get TorService --all-namespaces
NAMESPACE       NAME             ONION DOMAIN                                                     READY
tor-hidden-ns   my-tor-service   b5elviw6xff3udj4ayfjwdehp4mclsnsv6jewj4cfgvmdx7gz6cgsuad.onion   true

odonnell@lin-behemoth:~/development/internal_git/theCrypt/kubernetes$ kubectl get all -n tor-hidden-ns
NAME                                 READY   STATUS    RESTARTS   AGE
pod/nginx-website-655b9fc577-tpp7b   1/1     Running   0          93s

NAME                            TYPE        CLUSTER-IP       EXTERNAL-IP   PORT(S)   AGE
service/nginx-website-service   ClusterIP   10.102.162.204   <none>        80/TCP    94s

NAME                            READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/nginx-website   1/1     1            1           94s

NAME                                       DESIRED   CURRENT   READY   AGE
replicaset.apps/nginx-website-655b9fc577   1         1         1       94s

```



# Next Steps

* Separate Nginx and Tor proxy as two different pods
* Continue to update web content to look better
* Add javascript, python, or php to make the website more dynamic. Preferably not php.
