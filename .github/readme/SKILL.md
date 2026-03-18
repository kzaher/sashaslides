---
name: readme
description: This document contains the general information how to contribute to the project.
---

# SashaSlides

Sasha slides is a bot which allows generation of presentation in the same form like Midjourney.

The user shares a presentation link and tells the bot to either add new slide with certain content or improve slide with certain number.

Then the bot generates 4 suggestions for slide and the user picks one. After the user picks one, it's imported into slides presentation.

# Architecture

* I want a docker container for development in vscode. Everything should be developed in it.
* Bazelisk and blaze should be used.
* The main language will be python.
* Some type checker should be used and formatted.
* Type annotations should be used.

# Composer

* System which takes a generate slide request and generates a suggestion of 4 slide suggestions.
* This should be a python server which uses claude haiku to generate slide suggestions.

# Chat Bot

* Chat bot which integrates with Google Chat and every thread to which it's called it has the following workflow.
  1. Asks for presentation to be shared.
  2. Asks for slide number of content for slide to be shared.
  3. Proposes 4 images of slides.
  4. User enters number.
  5. Adds that slide as new or replaces if the user entered a message.
  6. Loops to 2.
* When the user interacts with chat bot, data is written in sqlite database.

# Data model

* Every chat and action is stored in a sqlite database with actions per thread in which the SashaSlides bot is invited or DMed:
  1. User link to the presentation.
  2. User request to generate slide for a presentation with content or slide number. The content is fetched from a slide as some format, probably json.
  3. 4 slide contents.
* The ids are both internal, and ids from Google Chat.
* The system also writes what is the type of slides or chat being used: Google, Microsoft, Discord ...

In general:
* Slide contents are stored in a separate table.
* Only references to content are stored in thread.
* Tables have only these fields:
  * Id which always ascends
  * Fields for indexing.
  * All fields are stored as json in one field.
* All data in the app is made from protbufs, there is no raw json parsed or worked with.
* Data format for google slides should be discovered. Take a look at Google Slides API.

# Logo

* The logo is some kind of cute Russian/Jewish Bear with Hearts and Slides. Design something.

# Tone

* The tone is funny and humorous. You can intentionally write misspellings to convey easter european accent.

# Website

* Has to be deployable to SashaSlides.com (domain bought)
* Website contains only an explanation how it works and link to Google Chat with prearranged message to our bot.

# Development

* Everything is done in vscode dev container.
* Test everything you can.
* Use bazelisk and blaze for build system for everything.
* Create docker-compose files for the entire system.
* Don't manually build protobufs, only rely on bazelisk/bazel rules.
* When you are booting server or testing E2E add scripts which boot the servers and perform the request issuance. This will automatically be E2E tests.

# Important

Always update README.md with important conclusions, decisions and gotchas. Always read it at start to understand everything. If something in this doc is creating issues for you, also change this skill doc.