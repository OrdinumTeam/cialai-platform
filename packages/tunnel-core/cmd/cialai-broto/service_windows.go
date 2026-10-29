//go:build windows

package main

import (
	"context"
	"golang.org/x/sys/windows/svc"
)

type serviceHandler struct{ serve func(context.Context) error }

func (h serviceHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	changes <- svc.Status{State: svc.StartPending}
	done := make(chan error, 1)
	go func() { done <- h.serve(ctx) }()
	changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case err := <-done:
			if err != nil {
				return false, 1
			}
			return false, 0
		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				changes <- request.CurrentStatus
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending}
				cancel()
				<-done
				return false, 0
			}
		}
	}
}
func runService(ctx context.Context, serve func(context.Context) error) error {
	service, err := svc.IsWindowsService()
	if err != nil {
		return err
	}
	if !service {
		return serve(ctx)
	}
	return svc.Run("CialaiBroto", serviceHandler{serve})
}
