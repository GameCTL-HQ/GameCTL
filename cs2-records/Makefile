REGISTRY ?= registry.example.com:5000
IMAGE    ?= $(REGISTRY)/cs2-records:dev
SHA      := $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)

.PHONY: build image push deploy run

build:
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o ./bin/cs2-records .

run: build
	GAMECTL_RECORDS_PATH=$(PWD)/sample-records.json ./bin/cs2-records

image:
	docker build -t $(IMAGE) -t $(REGISTRY)/cs2-records:$(SHA) .

push: image
	docker push $(IMAGE)
	docker push $(REGISTRY)/cs2-records:$(SHA)

deploy: push
	sed "s#image: replace-me#image: $(REGISTRY)/cs2-records:$(SHA)#" $(CURDIR)/../k8s/cs2-records.yaml | kubectl apply -f -
	kubectl rollout restart deployment/cs2-records -n gamectl
	kubectl rollout status  deployment/cs2-records -n gamectl --timeout=120s
