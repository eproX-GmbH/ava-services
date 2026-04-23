#!/usr/bin/env bash

fly scale count 0 --app ava-master-data
fly scale count 0 --app ava-website
fly scale count 0 --app ava-structured-content
fly scale count 0 --app ava-company-publication
fly scale count 0 --app ava-company-profile
fly scale count 0 --app ava-company-evaluation
fly scale count 0 --app ava-company-contact

