terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" { type = string }
variable "domain_name" { type = string }
variable "accel_name" { type = string default = "nines-global-accelerator" }
variable "cw_namespace" { type = string default = "NinesBackend" }
variable "alb_arn" { type = string }
variable "ga_listener_port" { type = number default = 443 }
variable "ga_listener_protocol" { type = string default = "TCP" }
variable "ga_endpoint_region" { type = string }
variable "ga_dns_name" { type = string }

# Route 53 hosted zone
resource "aws_route53_zone" "primary" {
  name = var.domain_name
}

# Global Accelerator
resource "aws_globalaccelerator_accelerator" "ga" {
  name               = var.accel_name
  ip_address_type    = "IPV4"
  enabled            = true
}

resource "aws_globalaccelerator_listener" "ga_listener" {
  accelerator_arn = aws_globalaccelerator_accelerator.ga.id
  port_ranges { from_port = var.ga_listener_port to_port = var.ga_listener_port }
  protocol = var.ga_listener_protocol
}

resource "aws_globalaccelerator_endpoint_group" "ga_group" {
  listener_arn = aws_globalaccelerator_listener.ga_listener.id
  endpoint_group_region = var.ga_endpoint_region
  health_check_interval_seconds = 30
  health_check_protocol = "TCP"
  endpoint_configuration {
    endpoint_id = var.alb_arn
    weight      = 100
  }
}

# WAF (placeholder ACL)
resource "aws_wafv2_web_acl" "api" {
  name        = "nines-waf"
  scope       = "CLOUDFRONT"
  description = "Basic WAF for API"
  default_action { allow {} }
  visibility_config {
    sampled_requests_enabled = true
    cloudwatch_metrics_enabled = true
    metric_name = "nines-waf"
  }
}

# ALB (Regional) placeholder
resource "aws_lb" "alb" {
  name               = "nines-alb"
  load_balancer_type = "application"
  internal           = false
  subnets            = var.public_subnets
  security_groups    = [var.alb_sg]
}

variable "public_subnets" { type = list(string) }
variable "alb_sg" { type = string }

# ACM cert placeholder
resource "aws_acm_certificate" "cert" {
  domain_name       = var.domain_name
  validation_method = "DNS"
}

output "zone_id" { value = aws_route53_zone.primary.zone_id }
output "ga_dns" { value = aws_globalaccelerator_accelerator.ga.dns_name }

# Route53 records pointing to GA DNS (CNAME)
resource "aws_route53_record" "api" {
  zone_id = aws_route53_zone.primary.zone_id
  name    = "api.${var.domain_name}"
  type    = "CNAME"
  ttl     = 60
  records = [var.ga_dns_name != "" ? var.ga_dns_name : aws_globalaccelerator_accelerator.ga.dns_name]
}
resource "aws_route53_record" "ws" {
  zone_id = aws_route53_zone.primary.zone_id
  name    = "ws.${var.domain_name}"
  type    = "CNAME"
  ttl     = 60
  records = [var.ga_dns_name != "" ? var.ga_dns_name : aws_globalaccelerator_accelerator.ga.dns_name]
}

# CloudWatch Alarm: dropped tick frames (example)
resource "aws_cloudwatch_metric_alarm" "dropped_ticks" {
  alarm_name          = "nines-dropped-tick-frames"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ws_dropped_tick_frames"
  namespace           = var.cw_namespace
  period              = 60
  statistic           = "Sum"
  threshold           = 1000
  actions_enabled     = false
  alarm_description   = "High dropped tick frames detected"
}
